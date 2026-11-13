//! A development host for the phone app: the app's own remote-access code
//! (pairing, accepting, serving streams) over one fake session, so the phone
//! app in the Simulator can pair, watch and type without the desktop app.
//! Never part of the app.
//!
//! ```sh
//! cargo run -p kriyon --example dev_host -- [invite-file]
//! ```
//!
//! It prints the pairing code (the QR code's text) and writes it to
//! `invite-file` if given. Paste it into the phone; then type the six digits
//! the phone shows here, one line. The session prints a line every two
//! seconds; what the phone types is echoed into it. Its readable view is a
//! short made-up conversation that grows from when it is opened, ending on a
//! question.

use std::collections::HashMap;
use std::io::BufRead as _;
use std::sync::Arc;
use std::time::{Duration, Instant};

use kriyon_core::readable::{EntryKind, Keyed, StepState};
use kriyon_core::session::SessionStatus;
use kriyon_core::standing::StandingState;
use kriyon_lib::daemon_client::DaemonEvent;
use kriyon_lib::remote_rt::{CodeOutcome, HostSetup, RemoteRuntime};
use kriyon_lib::remote_serve::{EntriesBuilt, LiveSession, RemoteStart, Serve, ServeHost};
use kriyon_remote::authorize::{PendingWrite, ProjectFolder};
use kriyon_remote::control::{Change, HostIsTyping};
use kriyon_remote::message::{EndpointId, ProjectInfo, RefuseReason, Role, SessionInfo};
use kriyon_remote::writer::SessionGate;
use kriyon_remote_link::host::{Host, PairedDevices};
use kriyon_remote_link::LinkConfig;
use parking_lot::Mutex;

/// The one session's id.
const SESSION: &str = "dev";
/// Its screen size.
const SIZE: (u16, u16) = (80, 24);
/// Lines the screen keeps for a snapshot.
const SCREEN_LINES: usize = 20;

/// The app, faked: paired devices in memory, one session.
struct DevApp {
    paired: Mutex<HashMap<EndpointId, Role>>,
    gate: Mutex<SessionGate>,
    /// The session's last lines, for snapshots.
    lines: Mutex<Vec<String>>,
    serve: Mutex<Option<Serve>>,
    /// When the readable view was first read since nobody read it: its
    /// conversation follows the clock from there.
    reading_since: Mutex<Instant>,
    /// When its entries were last built: a reader looks every second or so.
    last_read: Mutex<Option<Instant>>,
}

impl DevApp {
    fn tell(&self, change: Option<Change>) {
        let serve = self.serve.lock().clone();
        if let (Some(serve), Some(change)) = (serve, change) {
            serve.broadcast_control(SESSION, change);
        }
    }

    /// Output from the session: kept for snapshots, sent to watchers.
    fn output(&self, text: &str) {
        {
            let mut lines = self.lines.lock();
            lines.push(text.trim_end().to_string());
            let extra = lines.len().saturating_sub(SCREEN_LINES);
            lines.drain(..extra);
        }
        let serve = self.serve.lock().clone();
        if let Some(serve) = serve {
            let _ = serve.on_event(SESSION, DaemonEvent::Output(text.as_bytes()));
        }
    }

    /// The screen as it is now: cleared, then the kept lines.
    fn snapshot(&self) -> Vec<u8> {
        let mut screen = b"\x1b[2J\x1b[H".to_vec();
        for line in self.lines.lock().iter() {
            screen.extend_from_slice(line.as_bytes());
            screen.extend_from_slice(b"\r\n");
        }
        screen
    }
}

/// Claude's reply in the made-up conversation, which arrives a few words at
/// a time.
const REPLY: &str = "The login form sends the password before the token is ready, so the \
first try always fails. I'll wait for the token, then send.";

/// The made-up conversation at `beat` (one every two seconds): the reply
/// grows in place, a step runs then finishes, a report, then a question
/// answered only in the terminal, where it stays.
fn conversation(beat: u64) -> Vec<Keyed> {
    let keyed = |key: &str, kind: EntryKind| Keyed {
        key: key.into(),
        kind,
    };
    let mut entries = vec![keyed(
        "you",
        EntryKind::You {
            text: "Fix the login bug on the sign-in page".into(),
        },
    )];
    let words: Vec<&str> = REPLY.split(' ').collect();
    let shown = usize::try_from(beat * 4)
        .unwrap_or(usize::MAX)
        .min(words.len());
    entries.push(keyed(
        "claude",
        EntryKind::Claude {
            text: words[..shown.max(1)].join(" "),
            done: shown == words.len(),
        },
    ));
    if beat >= 3 {
        entries.push(keyed(
            "read",
            EntryKind::Step {
                name: "Read".into(),
                target: "src/login.ts".into(),
                state: if beat >= 5 {
                    StepState::Done
                } else {
                    StepState::Running
                },
            },
        ));
    }
    if beat >= 6 {
        entries.push(keyed(
            "test",
            EntryKind::Step {
                name: "Bash".into(),
                target: "npm test".into(),
                state: if beat >= 8 {
                    StepState::Failed
                } else {
                    StepState::Running
                },
            },
        ));
    }
    if beat >= 8 {
        entries.push(keyed(
            "report",
            EntryKind::Report {
                summary: "Waited for the token before sending; one test still fails.".into(),
                outcome: "Finished".into(),
            },
        ));
    }
    if beat >= 9 {
        entries.push(keyed(
            "note",
            EntryKind::Note {
                text: "Context compacted".into(),
            },
        ));
    }
    if beat >= 10 {
        entries.push(keyed(
            "asking",
            EntryKind::Asking {
                header: "Tests".into(),
                question: "Fix the failing test too?".into(),
                options: vec!["Yes, fix it".into(), "No, leave it".into()],
            },
        ));
    }
    entries
}

impl PairedDevices for DevApp {
    fn role(&self, device: &EndpointId) -> Option<Role> {
        self.paired.lock().get(device).copied()
    }
}

impl ServeHost for DevApp {
    fn host_name(&self) -> String {
        "Dev host".into()
    }

    fn sessions(&self) -> Vec<SessionInfo> {
        vec![SessionInfo {
            id: SESSION.into(),
            title: "Dev session".into(),
            project_id: "dev".into(),
            status: SessionStatus::Waiting,
            standing: StandingState::AwaitingInput,
            needs_you: true,
            dialog_open: false,
            last_change_ms: 0,
        }]
    }

    fn session(&self, id: &str) -> Option<LiveSession> {
        if id != SESSION {
            return None;
        }
        let gate = self.gate.lock();
        Some(LiveSession {
            run: gate.run()?,
            control: gate.control().clone(),
            dialog: gate.dialog(),
            size: gate.screen(),
        })
    }

    fn set_onlooked(&self, id: &str, onlooked: bool) {
        println!(
            "dev host: {id} {}",
            if onlooked {
                "watched"
            } else {
                "no longer watched"
            }
        );
    }

    fn set_push_token(&self, device: &EndpointId, key_id: u32, sealed: Vec<u8>) {
        println!(
            "dev host: push token from {} (key {key_id}, {} bytes)",
            kriyon_remote::message::hex(device),
            sealed.len()
        );
    }

    fn entries(&self, id: &str, stamp: Option<u64>) -> EntriesBuilt {
        if id != SESSION {
            return EntriesBuilt::Unavailable(
                kriyon_remote::message::EntriesUnavailable::NoTranscript,
            );
        }
        // Opened while nobody was reading: the conversation starts from the
        // beginning. A second reader joins it where it is.
        let idle = self
            .last_read
            .lock()
            .replace(Instant::now())
            .is_none_or(|last| last.elapsed() > Duration::from_secs(5));
        if stamp.is_none() && idle {
            *self.reading_since.lock() = Instant::now();
        }
        let beat = self.reading_since.lock().elapsed().as_secs() / 2;
        if stamp == Some(beat) {
            return EntriesBuilt::Unchanged;
        }
        EntriesBuilt::Built {
            stamp: beat,
            entries: conversation(beat),
        }
    }

    fn projects(&self) -> Vec<ProjectInfo> {
        Vec::new()
    }

    fn project_folder(&self, _project_id: &str) -> ProjectFolder {
        ProjectFolder::NoSuchProject
    }

    fn started(
        &self,
        _device: &EndpointId,
        _request_id: &[u8; 16],
    ) -> Option<Result<String, RefuseReason>> {
        None
    }

    fn start_session(
        &self,
        _device: EndpointId,
        _start: RemoteStart,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, RefuseReason>> + Send>>
    {
        Box::pin(async { Err(RefuseReason::NotAllowed) })
    }

    fn device_input(
        &self,
        _id: &str,
        device: &EndpointId,
        role: Role,
        write: &PendingWrite,
        bytes: &[u8],
    ) -> Result<bool, RefuseReason> {
        self.gate
            .lock()
            .device_write(device, Some(role), write, None)?;
        // What a shell would echo back.
        let typed = String::from_utf8_lossy(bytes).replace('\r', "\r\n");
        println!("dev host: typed {typed:?}");
        self.output(&typed);
        Ok(true)
    }

    fn device_resize(
        &self,
        _id: &str,
        device: &EndpointId,
        role: Role,
        write: &PendingWrite,
        size: (u16, u16),
    ) -> Result<bool, RefuseReason> {
        self.gate
            .lock()
            .device_write(device, Some(role), write, Some(size))?;
        Ok(true)
    }

    fn role_now(&self, _device: &EndpointId, connected: Role) -> Option<Role> {
        Some(connected)
    }

    fn take(&self, _id: &str, device: EndpointId, _role: Role) -> Result<(), RefuseReason> {
        let change = self
            .gate
            .lock()
            .take(device, Instant::now())
            .map_err(|HostIsTyping| RefuseReason::NotInControl)?;
        println!("dev host: the phone took control");
        self.tell(change);
        Ok(())
    }

    fn release(&self, device: &EndpointId) {
        let change = self.gate.lock().release(*device).change;
        self.tell(change);
    }
}

fn main() {
    let invite_file = std::env::args().nth(1);
    tauri::async_runtime::block_on(run(invite_file));
}

async fn run(invite_file: Option<String>) {
    let mut gate = SessionGate::new(1, SIZE);
    gate.set_run(1);
    let app = Arc::new(DevApp {
        paired: Mutex::default(),
        gate: Mutex::new(gate),
        lines: Mutex::default(),
        serve: Mutex::default(),
        reading_since: Mutex::new(Instant::now()),
        last_read: Mutex::default(),
    });
    let serve = Serve::new(Arc::clone(&app) as Arc<dyn ServeHost>);
    *app.serve.lock() = Some(serve.clone());
    // A snapshot asked for is answered at once, from the kept lines.
    let snapshots = Arc::clone(&app);
    let answer = serve.clone();
    serve.attach(
        SESSION,
        move |requester| {
            let screen = snapshots.snapshot();
            let _ = answer.on_event(
                SESSION,
                DaemonEvent::Snapshot {
                    id: requester,
                    bytes: &screen,
                },
            );
            let _ = answer.on_event(SESSION, DaemonEvent::SnapshotEnd { id: requester });
        },
        || SIZE,
    );
    let _ = serve.on_event(SESSION, DaemonEvent::Hello { run: 1 });

    let host = Arc::new(
        Host::bind(
            &LinkConfig::new(kriyon_remote_link::endpoint::generate_secret_key()),
            Arc::clone(&app) as Arc<dyn PairedDevices>,
            60,
        )
        .await
        .expect("the dev host binds"),
    );
    let runtime = Arc::new(RemoteRuntime::default());
    runtime.serve_with(serve.clone());
    let releaser = Arc::clone(&app);
    runtime
        .turn_on(HostSetup {
            host,
            on_code_wanted: Arc::new(|name| {
                println!("dev host: {name} wants to pair: type the code it shows, then Enter");
            }),
            on_device_gone: Arc::new(move |device| releaser.release(&device)),
        })
        .await
        .expect("remote access comes up");
    let invite = runtime
        .start_pairing(Role::Controller)
        .await
        .expect("pairing starts")
        .to_qr_text();
    println!("dev host: pairing code:\n{invite}");
    if let Some(path) = invite_file {
        std::fs::write(&path, &invite).expect("the invite file is written");
        println!("dev host: written to {path}");
    }

    // The session talks every two seconds.
    let talker = Arc::clone(&app);
    tauri::async_runtime::spawn(async move {
        let mut line = 0_u64;
        loop {
            line += 1;
            talker.output(&format!("dev session line {line}\r\n"));
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });

    // Codes typed here, one a line.
    let (codes_in, mut codes) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if codes_in.send(line.trim().to_string()).is_err() {
                return;
            }
        }
    });
    while let Some(code) = codes.recv().await {
        let keep = Arc::clone(&app);
        let outcome = runtime
            .enter_code(&code, "Dev host", |device, _name, role| {
                keep.paired.lock().insert(device, role);
                true
            })
            .await;
        match outcome {
            Ok(CodeOutcome::Paired { name, .. }) => println!("dev host: paired with {name}"),
            other => println!("dev host: {other:?}"),
        }
    }
}
