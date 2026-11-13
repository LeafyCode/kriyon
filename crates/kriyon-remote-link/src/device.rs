//! A [Remote device]'s side: pairing, connecting, staying connected.

use std::future::Future;

use iroh::endpoint::{Connection, VarInt};
use iroh::{Endpoint, EndpointAddr};
use kriyon_remote::codec::Decoded;
use kriyon_remote::link_policy::{Backoff, CloseCode};
use kriyon_remote::message::{
    EndpointId, FromDevice, PairFromDevice, PairToDevice, RefuseReason, ToDevice,
};
use kriyon_remote::pairing::{
    exporter_context, pair_proof, pairing_code, PairingSecret, EXPORTED_LEN, EXPORTER_LABEL,
};

use crate::endpoint::{gone, LinkConfig, LinkError, ALPN_PAIR, ALPN_REMOTE};
use crate::framed::{MessageReader, MessageWriter};

/// A device's endpoint. It only dials out.
pub struct Device {
    endpoint: Endpoint,
}

impl Device {
    /// # Errors
    /// [`LinkError::Bind`].
    pub async fn bind(config: &LinkConfig) -> Result<Self, LinkError> {
        let endpoint = crate::endpoint::bind(config, Vec::new()).await?;
        Ok(Self { endpoint })
    }

    async fn dial(&self, host: EndpointAddr, alpn: &[u8]) -> Result<Connection, LinkError> {
        self.endpoint
            .connect(host, alpn)
            .await
            .map_err(|e| LinkError::Connect(e.to_string()))
    }

    #[must_use]
    pub fn id(&self) -> EndpointId {
        crate::endpoint::id_bytes(&self.endpoint)
    }

    /// Pair with the host in the QR code: prove the secret, wait for the host
    /// to accept the proof, then show the code this connection derives.
    ///
    /// # Errors
    /// A [`LinkError`]: unreachable, no pairing pending, or refused.
    pub async fn pair(
        &self,
        host: EndpointAddr,
        secret: &PairingSecret,
        name: &str,
    ) -> Result<DevicePairing, LinkError> {
        let host_id = *host.id.as_bytes();
        let connection = self.dial(host, ALPN_PAIR).await?;
        let (send, recv) = connection.open_bi().await.map_err(|e| gone(&e))?;
        let mut writer = MessageWriter::new(send);
        let device_id = self.id();
        writer
            .send(&PairFromDevice::PairRequest {
                device_name: name.to_string(),
                proof: pair_proof(secret, &device_id, &host_id),
            })
            .await?;
        // No code before the host has accepted the proof: a phone that lost
        // the race to a leaked QR code says pairing failed instead.
        let mut reader = MessageReader::new(recv);
        let answer = match reader.next().await? {
            Some(Decoded::Message(PairToDevice::ProofAccepted)) => Ok(()),
            Some(Decoded::Message(PairToDevice::Refused { reason })) => {
                Err(LinkError::Refused(reason))
            }
            Some(Decoded::Message(PairToDevice::Paired { .. }) | Decoded::Unknown { .. })
            | None => Err(LinkError::Refused(RefuseReason::UnknownMessage)),
        };
        if let Err(refused) = answer {
            connection.close(VarInt::from_u32(0), b"");
            return Err(refused);
        }
        let mut exported = [0_u8; EXPORTED_LEN];
        let context = exporter_context(&host_id, &device_id, secret);
        connection
            .export_keying_material(&mut exported, EXPORTER_LABEL, &context)
            .map_err(|e| LinkError::Connect(format!("{e:?}")))?;
        Ok(DevicePairing {
            connection,
            code: pairing_code(&exported),
            reader,
            _writer: writer,
        })
    }

    /// Connect to a paired host and open the control stream.
    ///
    /// # Errors
    /// A [`LinkError`]; `Closed(Some(CloseCode::NotPaired))` when the host
    /// doesn't know this device.
    pub async fn connect(&self, host: EndpointAddr) -> Result<DeviceLink, LinkError> {
        let connection = self.dial(host, ALPN_REMOTE).await?;
        Ok(DeviceLink { connection })
    }

    /// Close the endpoint.
    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

/// A pairing in progress on the device: show [`DevicePairing::code`], then
/// wait for the host's answer.
pub struct DevicePairing {
    connection: Connection,
    code: String,
    reader: MessageReader<PairToDevice>,
    _writer: MessageWriter<PairFromDevice>,
}

impl DevicePairing {
    /// The 6-digit code to show; the person types it into the host.
    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }

    /// Wait for the host. Store the host only on `Ok`.
    ///
    /// # Errors
    /// [`LinkError::Refused`] or a broken connection.
    pub async fn finish(mut self) -> Result<String, LinkError> {
        let answer = match self.reader.next().await? {
            Some(Decoded::Message(PairToDevice::Paired { host_name })) => Ok(host_name),
            Some(Decoded::Message(PairToDevice::Refused { reason })) => {
                Err(LinkError::Refused(reason))
            }
            Some(Decoded::Message(PairToDevice::ProofAccepted) | Decoded::Unknown { .. })
            | None => Err(LinkError::Refused(RefuseReason::UnknownMessage)),
        };
        // Done either way: hang up, which the host waits for.
        self.connection.close(VarInt::from_u32(0), b"");
        answer
    }
}

/// A connection to a paired host.
#[derive(Debug)]
pub struct DeviceLink {
    connection: Connection,
}

impl DeviceLink {
    /// Open a stream: the first is the control stream, then one per session.
    ///
    /// # Errors
    /// A [`LinkError`] once the connection is gone.
    pub async fn open_stream(
        &self,
    ) -> Result<(MessageWriter<FromDevice>, MessageReader<ToDevice>), LinkError> {
        let (send, recv) = self.connection.open_bi().await.map_err(|e| gone(&e))?;
        Ok((MessageWriter::new(send), MessageReader::new(recv)))
    }

    /// Wait until the connection closes, and say why if the host said.
    pub async fn closed(&self) -> Option<CloseCode> {
        crate::endpoint::close_code(&self.connection.closed().await)
    }
}

/// Stay connected to `host`: connect, hand each link to `run` until it ends,
/// and reconnect with backoff (up to 30 s). `run` returns whether the link
/// worked (it got the host's `Welcome`), which starts the backoff over.
/// Returns only when the host says this device isn't paired.
pub async fn stay_connected<F, Fut>(device: &Device, host: EndpointAddr, run: F) -> LinkError
where
    F: FnMut(DeviceLink) -> Fut,
    Fut: Future<Output = (bool, Option<CloseCode>)>,
{
    let mut run = run;
    let mut backoff = Backoff::default();
    loop {
        let code = match device.connect(host.clone()).await {
            Ok(link) => {
                let (worked, code) = run(link).await;
                if worked {
                    backoff.reset();
                }
                code
            }
            Err(LinkError::Closed(code)) => code,
            Err(_) => None,
        };
        if code == Some(CloseCode::NotPaired) {
            return LinkError::Closed(code);
        }
        tokio::time::sleep(backoff.next_delay()).await;
    }
}
