//! Sending the one alert through Apple's or Google's push service. Behind
//! [`Deliver`], so the server is tested with a fake.
//!
//! The alert says only "A session needs you": no session names, nothing
//! from the host. Details come over the encrypted link when the app opens.

use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use kriyon_remote::push::Platform;

use crate::gate::Alert;
use crate::jwt::{Es256Key, Rs256Key};

/// The alert's text, the same for everyone.
pub const ALERT_TEXT: &str = "A session needs you";

/// A provider token is made again after this long (APNs: between 20 and
/// 60 minutes).
const APNS_TOKEN_EVERY_SECS: u64 = 40 * 60;

/// The FCM scope a service account asks for.
const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";

/// Why an alert wasn't sent.
#[derive(Debug, PartialEq, Eq)]
pub enum DeliverError {
    /// This sender has no credentials for that platform.
    NotConfigured,
    /// The push service says the token is no longer valid.
    Gone,
    /// The push service refused or failed, with its status (0: no answer).
    Failed(u16),
}

/// Sends one alert.
pub trait Deliver: Send + Sync + 'static {
    /// Send `alert`; it is dropped once this returns.
    fn deliver(&self, alert: Alert) -> impl Future<Output = Result<(), DeliverError>> + Send;
}

/// APNs's settings: the `.p8` key's text and ids, and the app's bundle id.
pub struct ApnsConfig {
    pub key_pem: String,
    pub key_id: String,
    pub team_id: String,
    /// The app's bundle id (`apns-topic`).
    pub topic: String,
    /// `https://api.push.apple.com`, or the sandbox for development builds.
    pub endpoint: String,
}

/// FCM's settings, from the service account's JSON.
pub struct FcmConfig {
    pub project_id: String,
    pub client_email: String,
    pub private_key_pem: String,
    pub token_uri: String,
}

impl FcmConfig {
    /// From a service account's JSON key file.
    ///
    /// # Errors
    /// What is missing.
    pub fn from_service_account(json: &str) -> Result<Self, String> {
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|_| "the service account isn't JSON".to_string())?;
        let field = |name: &str| {
            value[name]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("the service account has no {name}"))
        };
        Ok(Self {
            project_id: field("project_id")?,
            client_email: field("client_email")?,
            private_key_pem: field("private_key")?,
            token_uri: field("token_uri")?,
        })
    }
}

/// One HTTP request, built apart from sending it so it can be checked.
#[derive(Debug, PartialEq)]
pub struct Request {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: serde_json::Value,
}

/// The APNs request for `token` with provider token `bearer`.
#[must_use]
pub fn apns_request(config: &ApnsConfig, bearer: &str, token: &str) -> Request {
    Request {
        url: format!("{}/3/device/{token}", config.endpoint.trim_end_matches('/')),
        headers: vec![
            ("authorization", format!("bearer {bearer}")),
            ("apns-topic", config.topic.clone()),
            ("apns-push-type", "alert".into()),
            ("apns-priority", "10".into()),
        ],
        body: serde_json::json!({ "aps": { "alert": ALERT_TEXT, "sound": "default" } }),
    }
}

/// The FCM request for `token` with access token `bearer`.
#[must_use]
pub fn fcm_request(config: &FcmConfig, bearer: &str, token: &str) -> Request {
    Request {
        url: format!(
            "https://fcm.googleapis.com/v1/projects/{}/messages:send",
            config.project_id
        ),
        headers: vec![("authorization", format!("Bearer {bearer}"))],
        body: serde_json::json!({
            "message": {
                "token": token,
                "notification": { "body": ALERT_TEXT },
                "android": { "priority": "high" },
            }
        }),
    }
}

/// The push services, for real.
pub struct PushServices {
    http: reqwest::Client,
    apns: Option<(ApnsConfig, Es256Key)>,
    fcm: Option<(FcmConfig, Rs256Key)>,
    apns_token: Mutex<Option<(String, u64)>>,
    fcm_token: tokio::sync::Mutex<Option<(String, u64)>>,
    now: fn() -> u64,
}

impl PushServices {
    /// With whichever of the two services is configured.
    ///
    /// # Errors
    /// A key that can't be read, or no HTTP client.
    pub fn new(
        apns: Option<ApnsConfig>,
        fcm: Option<FcmConfig>,
        now: fn() -> u64,
    ) -> Result<Self, String> {
        // reqwest's rustls has no crypto provider of its own; ring is the
        // one already here. A second install is refused, which is fine.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "no HTTP client".to_string())?;
        let apns = apns
            .map(|config| {
                let key = Es256Key::from_pem(&config.key_pem)
                    .map_err(|_| "the APNs key isn't a .p8 key".to_string())?;
                Ok::<_, String>((config, key))
            })
            .transpose()?;
        let fcm = fcm
            .map(|config| {
                let key = Rs256Key::from_pem(&config.private_key_pem)
                    .map_err(|_| "the service account's key isn't an RSA key".to_string())?;
                Ok::<_, String>((config, key))
            })
            .transpose()?;
        Ok(Self {
            http,
            apns,
            fcm,
            apns_token: Mutex::new(None),
            fcm_token: tokio::sync::Mutex::new(None),
            now,
        })
    }

    fn apns_bearer(&self, config: &ApnsConfig, key: &Es256Key) -> Result<String, DeliverError> {
        let now = (self.now)();
        let mut cached = self
            .apns_token
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((token, made)) = cached.as_ref() {
            if now.saturating_sub(*made) < APNS_TOKEN_EVERY_SECS {
                return Ok(token.clone());
            }
        }
        let token = key
            .apns_token(&config.key_id, &config.team_id, now)
            .map_err(|_| DeliverError::Failed(0))?;
        *cached = Some((token.clone(), now));
        Ok(token)
    }

    async fn fcm_bearer(&self, config: &FcmConfig, key: &Rs256Key) -> Result<String, DeliverError> {
        let now = (self.now)();
        let mut cached = self.fcm_token.lock().await;
        if let Some((token, until)) = cached.as_ref() {
            if now + 300 < *until {
                return Ok(token.clone());
            }
        }
        let assertion = key
            .google_assertion(&config.client_email, &config.token_uri, FCM_SCOPE, now)
            .map_err(|_| DeliverError::Failed(0))?;
        let response = self
            .http
            .post(&config.token_uri)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .send()
            .await
            .map_err(|_| DeliverError::Failed(0))?;
        let status = response.status().as_u16();
        if status != 200 {
            return Err(DeliverError::Failed(status));
        }
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|_| DeliverError::Failed(status))?;
        let token = body["access_token"]
            .as_str()
            .ok_or(DeliverError::Failed(status))?
            .to_string();
        let lasts = body["expires_in"].as_u64().unwrap_or(3600);
        *cached = Some((token.clone(), now + lasts));
        Ok(token)
    }

    async fn send(&self, request: Request) -> Result<u16, DeliverError> {
        let mut builder = self.http.post(&request.url).json(&request.body);
        for (name, value) in &request.headers {
            builder = builder.header(*name, value);
        }
        builder
            .send()
            .await
            .map(|response| response.status().as_u16())
            .map_err(|_| DeliverError::Failed(0))
    }
}

/// What a push service's status means for the alert.
///
/// # Errors
/// [`DeliverError::Gone`] for a token the service dropped, else
/// [`DeliverError::Failed`] with the status.
pub fn outcome(platform: Platform, status: u16) -> Result<(), DeliverError> {
    match (platform, status) {
        (_, 200) => Ok(()),
        // APNs: Unregistered. FCM: UNREGISTERED.
        (Platform::Apns, 410) | (Platform::Fcm, 404) => Err(DeliverError::Gone),
        (_, other) => Err(DeliverError::Failed(other)),
    }
}

impl Deliver for PushServices {
    async fn deliver(&self, alert: Alert) -> Result<(), DeliverError> {
        let request = match alert.platform {
            Platform::Apns => {
                let (config, key) = self.apns.as_ref().ok_or(DeliverError::NotConfigured)?;
                apns_request(config, &self.apns_bearer(config, key)?, &alert.token)
            }
            Platform::Fcm => {
                let (config, key) = self.fcm.as_ref().ok_or(DeliverError::NotConfigured)?;
                fcm_request(config, &self.fcm_bearer(config, key).await?, &alert.token)
            }
        };
        let status = self.send(request).await?;
        outcome(alert.platform, status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apns() -> ApnsConfig {
        ApnsConfig {
            key_pem: crate::jwt::tests::p8(),
            key_id: "KEY".into(),
            team_id: "TEAM".into(),
            topic: "com.example.kriyon".into(),
            endpoint: "https://api.push.apple.com/".into(),
        }
    }

    #[test]
    fn the_apns_request_is_a_plain_visible_alert_for_the_app() {
        let request = apns_request(&apns(), "jwt", "abcd");
        assert_eq!(request.url, "https://api.push.apple.com/3/device/abcd");
        assert!(request
            .headers
            .contains(&("authorization", "bearer jwt".into())));
        assert!(request
            .headers
            .contains(&("apns-topic", "com.example.kriyon".into())));
        assert!(request
            .headers
            .contains(&("apns-push-type", "alert".into())));
        assert_eq!(
            request.body,
            serde_json::json!({ "aps": { "alert": "A session needs you", "sound": "default" } })
        );
    }

    #[test]
    fn the_fcm_request_is_a_plain_visible_alert_for_the_token() {
        let config = FcmConfig {
            project_id: "proj".into(),
            client_email: "a@b".into(),
            private_key_pem: String::new(),
            token_uri: "https://oauth2.googleapis.com/token".into(),
        };
        let request = fcm_request(&config, "access", "tok");
        assert_eq!(
            request.url,
            "https://fcm.googleapis.com/v1/projects/proj/messages:send"
        );
        assert_eq!(
            request.headers,
            vec![("authorization", "Bearer access".into())]
        );
        assert_eq!(request.body["message"]["token"], "tok");
        assert_eq!(request.body["message"]["notification"]["body"], ALERT_TEXT);
        assert!(request.body["message"]["notification"]
            .get("title")
            .is_none());
    }

    #[test]
    fn a_service_account_file_gives_the_fcm_settings() {
        let json = serde_json::json!({
            "type": "service_account",
            "project_id": "proj",
            "client_email": "sender@proj.iam.gserviceaccount.com",
            "private_key": crate::jwt::tests::RSA_PEM,
            "token_uri": "https://oauth2.googleapis.com/token",
        });
        let config = FcmConfig::from_service_account(&json.to_string()).expect("reads");
        assert_eq!(config.project_id, "proj");
        assert!(FcmConfig::from_service_account("{}").is_err());
    }

    #[test]
    fn an_unregistered_token_is_gone_and_other_failures_say_their_status() {
        assert_eq!(outcome(Platform::Apns, 200), Ok(()));
        assert_eq!(outcome(Platform::Apns, 410), Err(DeliverError::Gone));
        assert_eq!(outcome(Platform::Fcm, 404), Err(DeliverError::Gone));
        assert_eq!(outcome(Platform::Fcm, 500), Err(DeliverError::Failed(500)));
    }

    #[test]
    fn the_apns_provider_token_is_kept_for_forty_minutes() {
        fn first() -> u64 {
            1_000
        }
        let services = PushServices::new(Some(apns()), None, first).expect("made");
        let (config, key) = services.apns.as_ref().expect("apns");
        let a = services.apns_bearer(config, key).expect("token");
        let b = services.apns_bearer(config, key).expect("token");
        assert_eq!(a, b, "not made again within the window");
    }

    #[test]
    fn a_platform_without_credentials_is_not_configured() {
        fn now() -> u64 {
            0
        }
        let services = PushServices::new(None, None, now).expect("made");
        let sent = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime")
            .block_on(services.deliver(Alert {
                platform: Platform::Fcm,
                token: "t".into(),
            }));
        assert_eq!(sent, Err(DeliverError::NotConfigured));
    }
}
