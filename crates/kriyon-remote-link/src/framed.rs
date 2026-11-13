//! Messages over one QUIC stream, framed by the `kriyon-remote` codec.

use std::marker::PhantomData;

use iroh::endpoint::{RecvStream, SendStream};
use kriyon_remote::codec::{encode, Decoded, Decoder, Wire};

use crate::endpoint::LinkError;

/// Reads messages of type `M` from a stream.
pub struct MessageReader<M> {
    recv: RecvStream,
    decoder: Decoder<M>,
    /// Kept here, not in the read future, so that future stays small.
    buf: Vec<u8>,
}

/// How much one read takes off the stream.
const READ_LEN: usize = 16 * 1024;

impl<M: Wire> MessageReader<M> {
    #[must_use]
    pub fn new(recv: RecvStream) -> Self {
        Self {
            recv,
            decoder: Decoder::new(),
            buf: vec![0; READ_LEN],
        }
    }

    /// The next message, or `None` once the stream has ended.
    ///
    /// # Errors
    /// [`LinkError::Protocol`] for bytes the codec refuses — close the
    /// stream — or [`LinkError::Closed`] / [`LinkError::Connect`] when the
    /// connection went away.
    pub async fn next(&mut self) -> Result<Option<Decoded<M>>, LinkError> {
        loop {
            if let Some(decoded) = self.decoder.next_message().map_err(LinkError::Protocol)? {
                return Ok(Some(decoded));
            }
            match self.recv.read(&mut self.buf).await {
                Ok(Some(n)) => self.decoder.push(&self.buf[..n]),
                Ok(None) => return Ok(None),
                Err(iroh::endpoint::ReadError::ConnectionLost(lost)) => {
                    return Err(crate::endpoint::gone(&lost))
                }
                Err(other) => return Err(LinkError::Connect(other.to_string())),
            }
        }
    }
}

/// Writes messages of type `M` to a stream.
pub struct MessageWriter<M> {
    send: SendStream,
    _message: PhantomData<M>,
}

impl<M: Wire> MessageWriter<M> {
    #[must_use]
    pub fn new(send: SendStream) -> Self {
        Self {
            send,
            _message: PhantomData,
        }
    }

    /// Send one message.
    ///
    /// # Errors
    /// [`LinkError::Protocol`] for a message over its limit, or a
    /// [`LinkError`] for a stream that's gone.
    pub async fn send(&mut self, message: &M) -> Result<(), LinkError> {
        let bytes = encode(message).map_err(LinkError::Protocol)?;
        self.send.write_all(&bytes).await.map_err(|e| match e {
            iroh::endpoint::WriteError::ConnectionLost(lost) => crate::endpoint::gone(&lost),
            other => LinkError::Connect(other.to_string()),
        })
    }

    /// Say nothing more will be sent on this stream.
    pub fn finish(&mut self) {
        // Already finished or reset: nothing more would be sent anyway.
        let _ = self.send.finish();
    }
}
