//! What the phone's screens show of a host, from the device runtime's view:
//! plain records the TypeScript side reads as is.

use kriyon_remote::device_view::HostView;
use kriyon_remote::message::{hex, EndpointId, Holder, Role};
use kriyon_remote_link::device_runtime::LinkState;

/// Where a host's link stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HostLink {
    /// Dialing, or waiting to dial again.
    Connecting,
    Connected,
    /// No heartbeat: "Disconnected, reconnecting. Typing is off."
    Lost,
    /// The host removed this phone.
    Removed,
}

/// Who types into a session now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum Typing {
    /// The person at the computer.
    Host,
    /// This phone.
    You,
    /// Another device.
    Other,
}

/// A project on a host, where a session can be started.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HostProject {
    pub id: String,
    pub name: String,
    /// Every session in it is parked there.
    pub parked: bool,
}

/// One session on a host.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HostSession {
    pub id: String,
    pub title: String,
    pub project_id: String,
    /// The session status, named as the desktop's JSON names it.
    pub status: String,
    /// The standing, named as the desktop's JSON names it.
    pub standing: String,
    pub needs_you: bool,
    pub dialog_open: bool,
    pub last_change_ms: i64,
    /// `None` until the host says.
    pub typing: Option<Typing>,
}

/// A host as the phone shows it.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HostState {
    pub host_id: String,
    pub link: HostLink,
    /// From the host's welcome; `None` until it comes.
    pub host_name: Option<String>,
    /// `viewer` or `controller`.
    pub role: Option<String>,
    pub sessions: Vec<HostSession>,
    /// The last refusal the host sent, by its name (`NotInControl`).
    pub refused: Option<String>,
    /// Where a session can be started there (a Controller only may).
    pub projects: Vec<HostProject>,
}

/// The name serde gives `value`: a unit variant's name, or a variant with
/// fields by its name alone.
fn name_of(value: &impl serde::Serialize) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(name)) => name,
        Ok(serde_json::Value::Object(fields)) => fields.keys().next().cloned().unwrap_or_default(),
        _ => String::new(),
    }
}

/// A refusal's name (`FolderNotAllowed`), as the phone matches on it.
#[must_use]
pub fn refusal_name(reason: &kriyon_remote::message::RefuseReason) -> String {
    name_of(reason)
}

/// The phone's record of `view` for host `host`, seen from device `me`.
#[must_use]
pub fn host_state(
    host: &EndpointId,
    me: &EndpointId,
    link: LinkState,
    view: &HostView,
) -> HostState {
    HostState {
        host_id: hex(host),
        link: match link {
            LinkState::Connecting => HostLink::Connecting,
            LinkState::Connected => HostLink::Connected,
            LinkState::Lost => HostLink::Lost,
            LinkState::Removed => HostLink::Removed,
        },
        host_name: view.host_name.clone(),
        role: view.role.map(|role| {
            match role {
                Role::Viewer => "viewer",
                Role::Controller => "controller",
            }
            .to_string()
        }),
        sessions: view
            .sessions
            .iter()
            .map(|session| HostSession {
                id: session.id.clone(),
                title: session.title.clone(),
                project_id: session.project_id.clone(),
                status: name_of(&session.status),
                standing: name_of(&session.standing),
                needs_you: session.needs_you,
                dialog_open: session.dialog_open,
                last_change_ms: session.last_change_ms,
                typing: view
                    .control
                    .get(&session.id)
                    .map(|control| typing(&control.holder, me)),
            })
            .collect(),
        refused: view.refused.as_ref().map(name_of),
        projects: view
            .projects
            .iter()
            .map(|project| HostProject {
                id: project.id.clone(),
                name: project.name.clone(),
                parked: project.parked,
            })
            .collect(),
    }
}

/// Who `holder` is, seen from device `me`.
#[must_use]
pub fn typing(holder: &Holder, me: &EndpointId) -> Typing {
    match holder {
        Holder::Host => Typing::Host,
        Holder::Device(device) if device == me => Typing::You,
        Holder::Device(_) => Typing::Other,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use kriyon_core::session::SessionStatus;
    use kriyon_core::standing::StandingState;
    use kriyon_remote::device_view::ControlState;
    use kriyon_remote::message::{Epoch, RefuseReason, SessionInfo};

    use super::*;

    const ME: EndpointId = [2; 32];
    const HOST: EndpointId = [0xab; 32];

    #[test]
    fn a_host_reads_as_its_sessions_with_who_types() {
        let view = HostView {
            host_name: Some("Mac".into()),
            role: Some(Role::Controller),
            sessions: vec![SessionInfo {
                id: "s1".into(),
                title: "Fix the build".into(),
                project_id: "p1".into(),
                status: SessionStatus::Waiting,
                standing: StandingState::AwaitingInput,
                needs_you: true,
                dialog_open: true,
                last_change_ms: 5,
            }],
            control: HashMap::from([(
                "s1".to_string(),
                ControlState {
                    holder: Holder::Device(ME),
                    epoch: Epoch {
                        host_boot_id: 1,
                        counter: 2,
                    },
                },
            )]),
            refused: Some(RefuseReason::NotInControl),
            projects: vec![kriyon_remote::message::ProjectInfo {
                id: "/work/app".into(),
                name: "app".into(),
                parked: true,
            }],
        };
        let state = host_state(&HOST, &ME, LinkState::Connected, &view);
        assert_eq!(state.host_id, "ab".repeat(32));
        assert_eq!(state.link, HostLink::Connected);
        assert_eq!(state.host_name.as_deref(), Some("Mac"));
        assert_eq!(state.role.as_deref(), Some("controller"));
        assert_eq!(state.refused.as_deref(), Some("NotInControl"));
        assert_eq!(
            state.projects,
            vec![HostProject {
                id: "/work/app".into(),
                name: "app".into(),
                parked: true
            }]
        );
        let session = &state.sessions[0];
        assert_eq!(
            (session.id.as_str(), session.title.as_str()),
            ("s1", "Fix the build")
        );
        assert_eq!(session.status, "waiting");
        assert_eq!(session.standing, "awaiting_input");
        assert!(session.needs_you && session.dialog_open);
        assert_eq!(session.typing, Some(Typing::You));
    }

    #[test]
    fn who_types_is_told_apart() {
        assert_eq!(typing(&Holder::Host, &ME), Typing::Host);
        assert_eq!(typing(&Holder::Device(ME), &ME), Typing::You);
        assert_eq!(typing(&Holder::Device([9; 32]), &ME), Typing::Other);
    }

    #[test]
    fn each_link_state_reads_as_the_phones() {
        for (link, want) in [
            (LinkState::Connecting, HostLink::Connecting),
            (LinkState::Connected, HostLink::Connected),
            (LinkState::Lost, HostLink::Lost),
            (LinkState::Removed, HostLink::Removed),
        ] {
            assert_eq!(
                host_state(&HOST, &ME, link, &HostView::default()).link,
                want
            );
        }
    }
}
