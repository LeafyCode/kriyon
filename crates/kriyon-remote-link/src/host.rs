//! The [Host]'s side: the accept loop, pairing, and cutting a device off.

use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use iroh::endpoint::{Accepting, Connection, IncomingAddr, WeakConnectionHandle};
use iroh::{Endpoint, EndpointAddr};
use kriyon_remote::codec::Decoded;
use kriyon_remote::link_policy::{CloseCode, CodeCheck, PendingPairing, RateLimit};
use kriyon_remote::message::{
    EndpointId, FromDevice, PairFromDevice, PairToDevice, RefuseReason, Role, ToDevice,
};
use kriyon_remote::pairing::{
    check_device_name, exporter_context, pairing_code, PairingSecret, EXPORTED_LEN, EXPORTER_LABEL,
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::endpoint::{close, gone, LinkConfig, LinkError, ALPN_PAIR, ALPN_REMOTE};
use crate::framed::{MessageReader, MessageWriter};

/// How long the host waits for a device to read a last message (`Paired`,
/// `Refused`) and hang up, before it closes the connection itself.
const FAREWELL: Duration = Duration::from_secs(5);

/// The window the unpaired-handshake limit counts over.
const UNPAIRED_WINDOW: Duration = Duration::from_secs(60);

/// The longest one handshake may take. Each runs on its own, so a slow or
/// stalled one only holds itself up.
const HANDSHAKE_WITHIN: Duration = Duration::from_secs(10);

/// The longest a pairing device may take to send its `PairRequest`.
const PAIR_REQUEST_WITHIN: Duration = Duration::from_secs(30);

/// Admitted connections waiting for the app to take them.
const ADMITTED_QUEUE: usize = 16;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic elsewhere while holding the lock leaves the data as it was;
    // carrying on is safer than taking the host down.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Who the host has paired, as the app's store knows it.
pub trait PairedDevices: Send + Sync + 'static {
    /// The role of `device` if it is paired.
    fn role(&self, device: &EndpointId) -> Option<Role>;
}

/// The host's endpoint and its accept loop. The loop runs in the background
/// from [`Host::bind`] until the host is dropped or closed; [`Host::accept`]
/// hands out what it admitted.
pub struct Host {
    shared: Arc<Shared>,
    admitted: tokio::sync::Mutex<mpsc::Receiver<Accepted>>,
    driver: JoinHandle<()>,
}

struct Shared {
    endpoint: Endpoint,
    /// Remote access is on: the host takes connections. Off, it offers no
    /// protocol and admits nothing, and its links have been closed.
    accepting: std::sync::atomic::AtomicBool,
    id: EndpointId,
    paired: Arc<dyn PairedDevices>,
    pairing: Mutex<Option<PendingPairing>>,
    unpaired: Mutex<RateLimit<IpAddr>>,
    /// Live remote connections by device. Also the lock that makes the
    /// role check and the registration one step, so [`Host::cut_off`] can't
    /// fall between them.
    live: Mutex<Vec<(EndpointId, WeakConnectionHandle)>>,
}

/// A connection the accept loop let through.
pub enum Accepted {
    /// A paired device on `kriyon/remote/1`.
    Remote(RemoteLink),
    /// A device on `kriyon/pair/1` while a pairing is pending.
    Pair(PairLink),
}

impl Host {
    /// Bind the host's endpoint and start accepting. `unpaired_per_minute` is
    /// how many refused handshakes one source may cause a minute before the
    /// host ignores its new handshakes. The limit goes by address, since the
    /// peer's id is only known after a handshake: during an attack from a
    /// shared address (a café's NAT), a paired device behind it waits too.
    ///
    /// # Errors
    /// [`LinkError::Bind`].
    pub async fn bind(
        config: &LinkConfig,
        paired: Arc<dyn PairedDevices>,
        unpaired_per_minute: u32,
    ) -> Result<Self, LinkError> {
        let endpoint = crate::endpoint::bind(config, Vec::new()).await?;
        Ok(Self::on_endpoint(endpoint, paired, unpaired_per_minute))
    }

    /// Host on an endpoint this computer already has, which also dials out
    /// as a device: one endpoint, one id, per computer. The host takes every
    /// incoming connection on it, and starts accepting.
    #[must_use]
    pub fn on_endpoint(
        endpoint: Endpoint,
        paired: Arc<dyn PairedDevices>,
        unpaired_per_minute: u32,
    ) -> Self {
        endpoint.set_alpns(vec![ALPN_REMOTE.to_vec()]);
        let shared = Arc::new(Shared {
            id: crate::endpoint::id_bytes(&endpoint),
            endpoint,
            accepting: std::sync::atomic::AtomicBool::new(true),
            paired,
            pairing: Mutex::new(None),
            unpaired: Mutex::new(RateLimit::new(unpaired_per_minute, UNPAIRED_WINDOW)),
            live: Mutex::new(Vec::new()),
        });
        let (sender, receiver) = mpsc::channel(ADMITTED_QUEUE);
        let driver = tokio::spawn(accept_loop(Arc::clone(&shared), sender));
        Self {
            shared,
            admitted: tokio::sync::Mutex::new(receiver),
            driver,
        }
    }

    /// Remote access off: offer no protocol, admit nothing, end any pairing,
    /// and close every device's connection. The endpoint stays, for dialing.
    pub fn stop_accepting(&self) {
        self.shared
            .accepting
            .store(false, std::sync::atomic::Ordering::SeqCst);
        *lock(&self.shared.pairing) = None;
        self.shared.endpoint.set_alpns(Vec::new());
        let live = std::mem::take(&mut *lock(&self.shared.live));
        for (_, handle) in live {
            if let Some(connection) = handle.upgrade() {
                close(&connection, CloseCode::HostClosing);
            }
        }
    }

    /// Remote access on again.
    pub fn start_accepting(&self) {
        self.shared
            .accepting
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.shared.endpoint.set_alpns(vec![ALPN_REMOTE.to_vec()]);
    }

    #[must_use]
    pub fn id(&self) -> EndpointId {
        self.shared.id
    }

    /// Where devices on this machine's networks reach the host.
    #[must_use]
    pub fn addr(&self) -> EndpointAddr {
        self.shared.endpoint.addr()
    }

    /// The person pressed "Pair a device": serve `kriyon/pair/1` for this
    /// secret and role until it is used, burned, expired or stopped. A new
    /// pairing replaces one still pending.
    pub fn start_pairing(&self, secret: PairingSecret, role: Role) {
        if !self
            .shared
            .accepting
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        *lock(&self.shared.pairing) = Some(PendingPairing::new(secret, role, Instant::now()));
        self.shared
            .endpoint
            .set_alpns(vec![ALPN_REMOTE.to_vec(), ALPN_PAIR.to_vec()]);
    }

    /// How long the pending pairing has left, by the host's own clock, or
    /// `None` when there is none. Zero once it expired or was burned.
    #[must_use]
    pub fn pairing_time_left(&self) -> Option<Duration> {
        lock(&self.shared.pairing)
            .as_ref()
            .map(|pairing| pairing.time_left(Instant::now()))
    }

    /// Stop serving `kriyon/pair/1`.
    pub fn stop_pairing(&self) {
        self.shared.stop_pairing();
    }

    /// The next connection that passed the peer check, or `None` once the
    /// endpoint is closed. Unpaired peers, pairing outside a pending pairing
    /// and rate-limited sources were closed or ignored before any stream.
    pub async fn accept(&self) -> Option<Accepted> {
        self.admitted.lock().await.recv().await
    }

    /// Close every live connection of `device` with `NotPaired`. Call after
    /// removing it from the store (or changing its role), so it can't stay
    /// connected with what it had.
    pub fn cut_off(&self, device: &EndpointId) {
        self.close_device(device, CloseCode::NotPaired);
    }

    /// Close every live connection of `device` so it reconnects: after its
    /// role changed, it comes back with the new one.
    pub fn reconnect(&self, device: &EndpointId) {
        self.close_device(device, CloseCode::HostClosing);
    }

    fn close_device(&self, device: &EndpointId, code: CloseCode) {
        let mut live = lock(&self.shared.live);
        live.retain(|(id, handle)| {
            let Some(connection) = handle.upgrade() else {
                return false;
            };
            if id == device {
                close(&connection, code);
                return false;
            }
            true
        });
    }

    /// Close the endpoint.
    pub async fn close(&self) {
        self.shared.endpoint.close().await;
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        // The loop holds the endpoint; stop it so the endpoint goes too. On a
        // shared endpoint that lives on, offer no protocol any more.
        self.driver.abort();
        self.shared.endpoint.set_alpns(Vec::new());
    }
}

/// Take incoming connections until the endpoint closes. Each handshake runs
/// in its own task, so one that stalls holds up nothing else.
async fn accept_loop(shared: Arc<Shared>, admitted: mpsc::Sender<Accepted>) {
    while let Some(incoming) = shared.endpoint.accept().await {
        let source = match incoming.remote_addr() {
            IncomingAddr::Ip(addr) => Some(addr.ip()),
            _ => None,
        };
        if source.is_some_and(|ip| lock(&shared.unpaired).over(&ip, Instant::now())) {
            // No answer at all: the cheapest thing for a source that keeps
            // failing.
            incoming.ignore();
            continue;
        }
        let Ok(accepting) = incoming.accept() else {
            continue;
        };
        tokio::spawn(handshake(
            Arc::clone(&shared),
            accepting,
            source,
            admitted.clone(),
        ));
    }
}

async fn handshake(
    shared: Arc<Shared>,
    accepting: Accepting,
    source: Option<IpAddr>,
    admitted: mpsc::Sender<Accepted>,
) {
    // Waits for the whole handshake: nothing sent as 0-RTT is read before it,
    // and the peer's id is proven.
    let Ok(Ok(connection)) = tokio::time::timeout(HANDSHAKE_WITHIN, accepting).await else {
        shared.note_refused(source);
        return;
    };
    if let Some(accepted) = admit(&shared, connection, source) {
        // The app has stopped taking connections only when the host is going.
        let _ = admitted.send(accepted).await;
    }
}

/// The peer check, before any stream: a paired id on the remote ALPN, or any
/// id on the pair ALPN while a pairing is open.
fn admit(shared: &Arc<Shared>, connection: Connection, source: Option<IpAddr>) -> Option<Accepted> {
    let device = *connection.remote_id().as_bytes();
    let refuse = |code| {
        close(&connection, code);
        shared.note_refused(source);
        None
    };
    if !shared.accepting.load(std::sync::atomic::Ordering::SeqCst) {
        // Remote access is off; nothing gets in, whatever got this far.
        close(&connection, CloseCode::HostClosing);
        return None;
    }
    match connection.alpn() {
        ALPN_REMOTE => {
            // The role check and the registration happen under one lock, so a
            // cut_off after the device is removed can't miss this connection.
            let mut live = lock(&shared.live);
            let Some(role) = shared.paired.role(&device) else {
                drop(live);
                return refuse(CloseCode::NotPaired);
            };
            live.retain(|(_, handle)| handle.upgrade().is_some());
            live.push((device, connection.weak_handle()));
            drop(live);
            Some(Accepted::Remote(RemoteLink {
                connection,
                device,
                role,
            }))
        }
        ALPN_PAIR => {
            let open = lock(&shared.pairing)
                .as_ref()
                .is_some_and(|pairing| pairing.open(Instant::now()));
            if !open {
                return refuse(CloseCode::NoPairing);
            }
            Some(Accepted::Pair(PairLink {
                connection,
                device,
                source,
                shared: Arc::clone(shared),
            }))
        }
        _ => refuse(CloseCode::ProtocolError),
    }
}

impl Shared {
    fn stop_pairing(&self) {
        *lock(&self.pairing) = None;
        if self.accepting.load(std::sync::atomic::Ordering::SeqCst) {
            self.endpoint.set_alpns(vec![ALPN_REMOTE.to_vec()]);
        }
    }

    /// A handshake or proof from `source` was refused: count it toward the
    /// limit.
    fn note_refused(&self, source: Option<IpAddr>) {
        if let Some(ip) = source {
            lock(&self.unpaired).record(ip, Instant::now());
        }
    }
}

/// Tell the device one last thing, then let it hang up (or close after
/// [`FAREWELL`]), so the message isn't lost to a close.
async fn farewell<M: kriyon_remote::codec::Wire>(
    connection: &Connection,
    writer: &mut MessageWriter<M>,
    last: &M,
    code: CloseCode,
) -> Result<(), LinkError> {
    let sent = writer.send(last).await;
    writer.finish();
    // The device hangs up once it has read it; closing first could drop it.
    let _ = tokio::time::timeout(FAREWELL, connection.closed()).await;
    close(connection, code);
    sent
}

/// A paired device's connection.
pub struct RemoteLink {
    connection: Connection,
    device: EndpointId,
    role: Role,
}

impl RemoteLink {
    #[must_use]
    pub fn device(&self) -> EndpointId {
        self.device
    }

    /// The role it was paired with, when it connected.
    #[must_use]
    pub fn role(&self) -> Role {
        self.role
    }

    /// The next stream the device opens: the control stream first, then one
    /// per session (at most 16 at once).
    ///
    /// # Errors
    /// A [`LinkError`] once the connection is gone.
    pub async fn accept_stream(
        &self,
    ) -> Result<(MessageWriter<ToDevice>, MessageReader<FromDevice>), LinkError> {
        let (send, recv) = self.connection.accept_bi().await.map_err(|e| gone(&e))?;
        Ok((MessageWriter::new(send), MessageReader::new(recv)))
    }

    /// Close the connection with `code`.
    pub fn close(&self, code: CloseCode) {
        close(&self.connection, code);
    }

    /// Wait until the connection closes, for whatever reason.
    pub async fn closed(&self) {
        self.connection.closed().await;
    }
}

/// A device's pairing connection, before its request is read.
pub struct PairLink {
    connection: Connection,
    device: EndpointId,
    source: Option<IpAddr>,
    shared: Arc<Shared>,
}

impl PairLink {
    /// Read the device's `PairRequest` (within 30 s), check its name and
    /// proof, and derive the pairing code from this connection. A refusal is
    /// sent to the device and the connection closed.
    ///
    /// # Errors
    /// [`LinkError::Refused`] for a bad name or proof, or another
    /// [`LinkError`] for a broken or silent connection.
    pub async fn request(self) -> Result<PairAttempt, LinkError> {
        let read = tokio::time::timeout(PAIR_REQUEST_WITHIN, async {
            let (send, recv) = self.connection.accept_bi().await.map_err(|e| gone(&e))?;
            let mut reader = MessageReader::<PairFromDevice>::new(recv);
            let request = reader.next().await?;
            Ok::<_, LinkError>((MessageWriter::<PairToDevice>::new(send), request))
        })
        .await;
        let Ok(read) = read else {
            close(&self.connection, CloseCode::ProtocolError);
            return Err(LinkError::Connect("no pairing request in time".into()));
        };
        let (mut writer, request) = read?;
        let checked = match request {
            Some(Decoded::Message(PairFromDevice::PairRequest { device_name, proof })) => self
                .check(&device_name, &proof)
                .map(|taken| (device_name, taken)),
            Some(Decoded::Unknown { .. }) => Err(RefuseReason::UnknownMessage),
            None => Err(RefuseReason::NotPaired),
        };
        let (name, (secret, role, time_left)) = match checked {
            Ok(checked) => checked,
            Err(reason) => {
                // Refused whether or not the device is still there to hear it.
                let refused = PairToDevice::Refused { reason };
                let _ = farewell(
                    &self.connection,
                    &mut writer,
                    &refused,
                    CloseCode::NotPaired,
                )
                .await;
                return Err(LinkError::Refused(reason));
            }
        };
        writer
            .send(&PairToDevice::ProofAccepted {
                role,
                expires_in_ms: u64::try_from(time_left.as_millis()).unwrap_or(u64::MAX),
            })
            .await?;
        let mut exported = [0_u8; EXPORTED_LEN];
        let context = exporter_context(&self.shared.id, &self.device, &secret);
        self.connection
            .export_keying_material(&mut exported, EXPORTER_LABEL, &context)
            .map_err(|e| LinkError::Connect(format!("{e:?}")))?;
        Ok(PairAttempt {
            connection: self.connection,
            device: self.device,
            name,
            secret,
            code: pairing_code(&exported),
            writer,
            shared: self.shared,
        })
    }

    /// Check the name and proof; the first right proof takes the pairing.
    /// Returns the secret it took. Every refusal counts toward the source's
    /// limit, without using up the pairing.
    /// The pairing's secret, the role it offers and how long it has left.
    fn check(
        &self,
        name: &str,
        proof: &[u8],
    ) -> Result<(PairingSecret, Role, Duration), RefuseReason> {
        let taken = check_device_name(name).and_then(|()| {
            let mut pairing = lock(&self.shared.pairing);
            let pending = pairing.as_mut().ok_or(RefuseReason::NotPaired)?;
            let now = Instant::now();
            pending.take(&self.device, &self.shared.id, proof, now)?;
            Ok((*pending.secret(), pending.role(), pending.time_left(now)))
        });
        if taken.is_err() {
            self.shared.note_refused(self.source);
        }
        taken
    }
}

/// A device that took the pairing, waiting for the person to type the code
/// it shows.
pub struct PairAttempt {
    connection: Connection,
    device: EndpointId,
    name: String,
    /// The pairing this attempt took, to tell it from a newer one.
    secret: PairingSecret,
    code: String,
    writer: MessageWriter<PairToDevice>,
    shared: Arc<Shared>,
}

impl PairAttempt {
    #[must_use]
    pub fn device(&self) -> EndpointId {
        self.device
    }

    /// The name the device gave itself ("named by the device").
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The person typed `entered`. On the right code, `store` saves the
    /// device and its role, and only then is the device told `Paired`, so it
    /// can dial in at once. If `store` says it couldn't save, the device is
    /// told `Refused` instead, and the check is `Burned`: a device told it is
    /// paired but not stored would be refused, and stop trying, for good. When the pairing is burned, or this attempt's
    /// pairing has been replaced by a newer one, the device is told `Refused`
    /// and the connection closes; a newer pairing is left as it is.
    ///
    /// # Errors
    /// A [`LinkError`] if the device can't be told.
    pub async fn confirm(
        &mut self,
        entered: &str,
        host_name: &str,
        store: impl FnOnce(EndpointId, Role) -> bool,
    ) -> Result<CodeCheck, LinkError> {
        let check = {
            let mut pairing = lock(&self.shared.pairing);
            match pairing.as_mut() {
                Some(pending)
                    if pending.secret() == &self.secret
                        && pending.taken_by() == Some(self.device) =>
                {
                    let check = pending.check_code(entered, &self.code, Instant::now());
                    if !matches!(check, CodeCheck::Wrong { .. }) {
                        drop(pairing);
                        self.shared.stop_pairing();
                    }
                    check
                }
                // Over, or replaced: this attempt pairs nothing, and a newer
                // pairing is not this attempt's to end.
                _ => CodeCheck::Burned,
            }
        };
        let check = match check {
            CodeCheck::Paired { device, role } if !store(device, role) => CodeCheck::Burned,
            other => other,
        };
        match check {
            CodeCheck::Wrong { .. } => {}
            CodeCheck::Paired { .. } => {
                let paired = PairToDevice::Paired {
                    host_name: host_name.to_string(),
                };
                farewell(
                    &self.connection,
                    &mut self.writer,
                    &paired,
                    CloseCode::HostClosing,
                )
                .await?;
            }
            CodeCheck::Burned => {
                let refused = PairToDevice::Refused {
                    reason: RefuseReason::NotPaired,
                };
                farewell(
                    &self.connection,
                    &mut self.writer,
                    &refused,
                    CloseCode::NotPaired,
                )
                .await?;
            }
        }
        Ok(check)
    }
}
