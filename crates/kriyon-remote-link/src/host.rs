//! The [Host]'s side: the accept loop, pairing, and cutting a device off.

use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use iroh::endpoint::{Connection, IncomingAddr, WeakConnectionHandle};
use iroh::{Endpoint, EndpointAddr};
use kriyon_remote::codec::Decoded;
use kriyon_remote::link_policy::{CloseCode, CodeCheck, PendingPairing, RateLimit};
use kriyon_remote::message::{
    EndpointId, FromDevice, PairFromDevice, PairToDevice, RefuseReason, Role, ToDevice,
};
use kriyon_remote::pairing::{
    check_device_name, exporter_context, pairing_code, PairingSecret, EXPORTED_LEN, EXPORTER_LABEL,
};

use crate::endpoint::{close, gone, LinkConfig, LinkError, ALPN_PAIR, ALPN_REMOTE};
use crate::framed::{MessageReader, MessageWriter};

/// How long the host waits for a device to read a last message (`Paired`,
/// `Refused`) and hang up, before it closes the connection itself.
const FAREWELL: Duration = Duration::from_secs(5);

/// The window the unpaired-handshake limit counts over.
const UNPAIRED_WINDOW: Duration = Duration::from_secs(60);

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

/// The host's endpoint and its accept loop.
pub struct Host {
    endpoint: Endpoint,
    shared: Arc<Shared>,
}

struct Shared {
    endpoint: Endpoint,
    id: EndpointId,
    paired: Arc<dyn PairedDevices>,
    pairing: Mutex<Option<PendingPairing>>,
    unpaired: Mutex<RateLimit<IpAddr>>,
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
    /// Bind the host's endpoint. `unpaired_per_minute` is how many handshakes
    /// refused as unpaired one source may cause a minute before the host
    /// ignores its new handshakes.
    ///
    /// # Errors
    /// [`LinkError::Bind`].
    pub async fn bind(
        config: &LinkConfig,
        paired: Arc<dyn PairedDevices>,
        unpaired_per_minute: u32,
    ) -> Result<Self, LinkError> {
        let endpoint = crate::endpoint::bind(config, vec![ALPN_REMOTE.to_vec()]).await?;
        let shared = Arc::new(Shared {
            endpoint: endpoint.clone(),
            id: crate::endpoint::id_bytes(&endpoint),
            paired,
            pairing: Mutex::new(None),
            unpaired: Mutex::new(RateLimit::new(unpaired_per_minute, UNPAIRED_WINDOW)),
            live: Mutex::new(Vec::new()),
        });
        Ok(Self { endpoint, shared })
    }

    #[must_use]
    pub fn id(&self) -> EndpointId {
        self.shared.id
    }

    /// Where devices on this machine's networks reach the host.
    #[must_use]
    pub fn addr(&self) -> EndpointAddr {
        self.endpoint.addr()
    }

    /// The person pressed "Pair a device": serve `kriyon/pair/1` for this
    /// secret and role until it is used, burned, expired or stopped.
    pub fn start_pairing(&self, secret: PairingSecret, role: Role) {
        *lock(&self.shared.pairing) = Some(PendingPairing::new(secret, role, Instant::now()));
        self.endpoint
            .set_alpns(vec![ALPN_REMOTE.to_vec(), ALPN_PAIR.to_vec()]);
    }

    /// Stop serving `kriyon/pair/1`.
    pub fn stop_pairing(&self) {
        self.shared.stop_pairing();
    }

    /// The next connection that passes the peer check, or `None` once the
    /// endpoint is closed. Unpaired peers, pairing outside a pending pairing
    /// and rate-limited sources are closed or ignored here, before any stream.
    pub async fn accept(&self) -> Option<Accepted> {
        loop {
            let incoming = self.endpoint.accept().await?;
            let source = match incoming.remote_addr() {
                IncomingAddr::Ip(addr) => Some(addr.ip()),
                _ => None,
            };
            if source.is_some_and(|ip| lock(&self.shared.unpaired).over(&ip, Instant::now())) {
                // No answer at all: the cheapest thing for a source that keeps
                // failing.
                incoming.ignore();
                continue;
            }
            let Ok(accepting) = incoming.accept() else {
                continue;
            };
            // Waits for the whole handshake: nothing sent as 0-RTT is read
            // before it, and the peer's id is proven.
            let Ok(connection) = accepting.await else {
                continue;
            };
            if let Some(accepted) = self.admit(connection, source) {
                return Some(accepted);
            }
        }
    }

    /// The peer check, before any stream: a paired id on the remote ALPN, or
    /// any id on the pair ALPN while a pairing is open.
    fn admit(&self, connection: Connection, source: Option<IpAddr>) -> Option<Accepted> {
        let device = *connection.remote_id().as_bytes();
        let refuse = |code| {
            close(&connection, code);
            self.shared.note_refused(source);
            None
        };
        match connection.alpn() {
            ALPN_REMOTE => {
                let Some(role) = self.shared.paired.role(&device) else {
                    return refuse(CloseCode::NotPaired);
                };
                self.shared.track(device, &connection);
                Some(Accepted::Remote(RemoteLink {
                    connection,
                    device,
                    role,
                }))
            }
            ALPN_PAIR => {
                let open = lock(&self.shared.pairing)
                    .as_ref()
                    .is_some_and(|pairing| pairing.open(Instant::now()));
                if !open {
                    return refuse(CloseCode::NoPairing);
                }
                Some(Accepted::Pair(PairLink {
                    connection,
                    device,
                    source,
                    shared: Arc::clone(&self.shared),
                }))
            }
            _ => refuse(CloseCode::ProtocolError),
        }
    }

    /// Close every live connection of `device` with `NotPaired`. Call after
    /// removing it from the store (or changing its role), so it can't stay
    /// connected with what it had.
    pub fn cut_off(&self, device: &EndpointId) {
        let mut live = lock(&self.shared.live);
        live.retain(|(id, handle)| {
            let Some(connection) = handle.upgrade() else {
                return false;
            };
            if id == device {
                close(&connection, CloseCode::NotPaired);
                return false;
            }
            true
        });
    }

    /// Close the endpoint.
    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

/// A paired device's connection.
pub struct RemoteLink {
    connection: Connection,
    device: EndpointId,
    role: Role,
}

impl Shared {
    fn stop_pairing(&self) {
        *lock(&self.pairing) = None;
        self.endpoint.set_alpns(vec![ALPN_REMOTE.to_vec()]);
    }

    /// A handshake from `source` was refused: count it toward the limit.
    fn note_refused(&self, source: Option<IpAddr>) {
        if let Some(ip) = source {
            lock(&self.unpaired).record(ip, Instant::now());
        }
    }

    /// Remember a live connection, so [`Host::cut_off`] can reach it.
    fn track(&self, device: EndpointId, connection: &Connection) {
        let mut live = lock(&self.live);
        live.retain(|(_, handle)| handle.upgrade().is_some());
        live.push((device, connection.weak_handle()));
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
    pub fn close(&self, code: kriyon_remote::link_policy::CloseCode) {
        crate::endpoint::close(&self.connection, code);
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
    /// Read the device's `PairRequest`, check its name and proof, and derive
    /// the pairing code from this connection. A refusal is sent to the device
    /// and the connection closed.
    ///
    /// # Errors
    /// [`LinkError::Refused`] for a bad name or proof, or another
    /// [`LinkError`] for a broken connection.
    pub async fn request(self) -> Result<PairAttempt, LinkError> {
        let (send, recv) = self.connection.accept_bi().await.map_err(|e| gone(&e))?;
        let mut reader = MessageReader::<PairFromDevice>::new(recv);
        let mut writer = MessageWriter::<PairToDevice>::new(send);
        let checked = match reader.next().await? {
            Some(Decoded::Message(PairFromDevice::PairRequest { device_name, proof })) => self
                .check(&device_name, &proof)
                .map(|secret| (device_name, secret)),
            Some(Decoded::Unknown { .. }) => Err(RefuseReason::UnknownMessage),
            None => Err(RefuseReason::NotPaired),
        };
        let (name, secret) = match checked {
            Ok(checked) => checked,
            Err(reason) => {
                let refused = PairToDevice::Refused { reason };
                farewell(
                    &self.connection,
                    &mut writer,
                    &refused,
                    CloseCode::NotPaired,
                )
                .await?;
                return Err(LinkError::Refused(reason));
            }
        };
        let mut exported = [0_u8; EXPORTED_LEN];
        let context = exporter_context(&self.shared.id, &self.device, &secret);
        self.connection
            .export_keying_material(&mut exported, EXPORTER_LABEL, &context)
            .map_err(|e| LinkError::Connect(format!("{e:?}")))?;
        Ok(PairAttempt {
            connection: self.connection,
            device: self.device,
            name,
            code: pairing_code(&exported),
            writer,
            shared: self.shared,
        })
    }

    /// Check the name and proof; the first right proof takes the pairing.
    /// Returns the secret, for the code.
    fn check(&self, name: &str, proof: &[u8]) -> Result<PairingSecret, RefuseReason> {
        check_device_name(name)?;
        let mut pairing = lock(&self.shared.pairing);
        let pending = pairing.as_mut().ok_or(RefuseReason::NotPaired)?;
        let taken = pending.take(&self.device, &self.shared.id, proof, Instant::now());
        if taken.is_err() {
            // Wrong proofs count toward the source's limit, without using up
            // the pairing.
            drop(pairing);
            self.shared.note_refused(self.source);
            return Err(RefuseReason::NotPaired);
        }
        Ok(*pending.secret())
    }
}

/// A device that took the pairing, waiting for the person to type the code
/// it shows.
pub struct PairAttempt {
    connection: Connection,
    device: EndpointId,
    name: String,
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

    /// The person typed `entered`. On the right code the device is told
    /// `Paired` (the caller stores it with the returned role first); when the
    /// pairing is burned it is told `Refused` and the connection closes.
    ///
    /// # Errors
    /// A [`LinkError`] if the device can't be told.
    pub async fn confirm(
        &mut self,
        entered: &str,
        host_name: &str,
    ) -> Result<CodeCheck, LinkError> {
        let check = {
            let mut pairing = lock(&self.shared.pairing);
            match pairing.as_mut() {
                Some(pending) => pending.check_code(entered, &self.code, Instant::now()),
                None => CodeCheck::Burned,
            }
        };
        match check {
            CodeCheck::Wrong { .. } => {}
            CodeCheck::Paired { .. } => {
                self.shared.stop_pairing();
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
                self.shared.stop_pairing();
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
