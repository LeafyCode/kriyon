//! Kriyon's phone library: the device side of remote access, for the phone
//! app through `UniFFI` (Swift now, Kotlin later). The logic is
//! `kriyon_remote_link::device_runtime`'s, the same as the desktop's; this
//! adds the phone's store (the device key and the paired computers) behind
//! a trait the app provides, and plain records for its screens.

uniffi::setup_scaffolding!();

pub mod device;
pub mod hosts;
pub mod push;
pub mod relay;

pub use device::{
    EntriesListener, HostListener, MobileDevice, MobileError, Pairing, PhoneStore, ScreenListener,
    StoreError,
};
pub use hosts::PairedHost;
