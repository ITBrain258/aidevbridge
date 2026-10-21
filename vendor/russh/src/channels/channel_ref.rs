// Changed by AgentBridge (now aidevbridge): local modifications to russh 0.63.2,
// Apache-2.0 like russh. AGENTBRIDGE-PATCH.md in the crate root lists every changed file.
use tokio::sync::mpsc::Sender;

use super::WindowSizeRef;
use super::end_observer::{ChannelEndEvent, ChannelEndObserver, ChannelEndWriter};
// AgentBridge local patch: state of a manual receive window.
use super::window_credit::ManualWindow;
use crate::ChannelMsg;

/// A handle to the [`super::Channel`]'s to be able to transmit messages
/// to it and update it's `window_size`.
#[derive(Debug)]
pub struct ChannelRef {
    pub(super) sender: Sender<ChannelMsg>,
    pub(super) window_size: WindowSizeRef,
    // AgentBridge local patch: retain only the expected peer Close after a
    // confirmed channel's local Close removes its encrypted channel state.
    pub(crate) awaiting_close: bool,
    // AgentBridge local patch: absent on paths without client end coverage.
    pub(super) end: Option<ChannelEndWriter>,
    // AgentBridge local patch: present only for a client session channel
    // whose receive window the application returns itself.
    pub(super) manual_window: Option<ManualWindow>,
}

impl ChannelRef {
    pub fn new(sender: Sender<ChannelMsg>) -> Self {
        Self {
            sender,
            window_size: WindowSizeRef::new(0),
            awaiting_close: false,
            end: None,
            // AgentBridge local patch: automatic window unless requested.
            manual_window: None,
        }
    }

    pub(crate) fn window_size(&self) -> &WindowSizeRef {
        &self.window_size
    }

    pub(crate) fn new_observed(sender: Sender<ChannelMsg>) -> Self {
        Self {
            end: Some(ChannelEndWriter::new()),
            ..Self::new(sender)
        }
    }

    pub(crate) fn end_observer(&self) -> Option<ChannelEndObserver> {
        self.end.as_ref().map(ChannelEndWriter::observer)
    }

    pub(crate) fn record_end(&self, event: ChannelEndEvent) {
        if let Some(writer) = &self.end {
            writer.record(event);
        }
    }

    // AgentBridge local patch: requested by the opening handle, read by the
    // session when it opens the channel and when data or credit arrives.
    pub(crate) fn with_manual_window(self, manual_window: ManualWindow) -> Self {
        Self {
            manual_window: Some(manual_window),
            ..self
        }
    }

    pub(crate) fn manual_window(&self) -> Option<&ManualWindow> {
        self.manual_window.as_ref()
    }
}

impl std::ops::Deref for ChannelRef {
    type Target = Sender<ChannelMsg>;

    fn deref(&self) -> &Self::Target {
        &self.sender
    }
}
