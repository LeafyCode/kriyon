//! Pure OSC 133 shell-integration block state machine. Terminals emit
//! `OSC 133 ; A | B | C | D[;<code>]` markers around each prompt/command/output
//! span; this module folds a stream of those markers (each tagged with the
//! absolute buffer line it was observed on) into completed [`Block`] ranges so
//! the UI can offer per-command "copy output".

use serde::{Deserialize, Serialize};

/// An OSC 133 semantic marker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Marker {
    /// `A` — the shell is about to draw a prompt.
    PromptStart,
    /// `B` — the prompt is drawn; command input starts here.
    CommandStart,
    /// `C` — command input ended; command output starts here.
    OutputStart,
    /// `D` — the command finished (optionally with an exit code).
    CommandEnd,
}

/// A completed command block: the prompt/command line plus its output range.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    /// Absolute buffer line of the prompt (or command start).
    pub command_line: u32,
    /// Absolute buffer line where output begins.
    pub output_start: u32,
    /// Absolute buffer line where output ends (the `D` marker line).
    pub output_end: u32,
    /// Shell exit code from the `D;<code>` marker, if reported.
    pub exit: Option<i32>,
}

/// In-progress state accumulated while a command block is open.
#[derive(Default)]
struct InProgress {
    command_line: Option<u32>,
    output_start: Option<u32>,
}

impl InProgress {
    fn is_empty(&self) -> bool {
        self.command_line.is_none() && self.output_start.is_none()
    }
}

/// Folds a stream of OSC 133 markers into completed [`Block`]s.
#[derive(Default)]
pub struct OscBlocks {
    current: InProgress,
    blocks: Vec<Block>,
}

impl OscBlocks {
    /// Create an empty state machine.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a marker observed at absolute buffer line `line`. `exit` is only
    /// meaningful for [`Marker::CommandEnd`] (the `D;<code>` exit code).
    ///
    /// The machine is deliberately tolerant of out-of-order or missing markers:
    /// a stray [`Marker::CommandEnd`] with no open block is ignored rather than
    /// panicking, and a `D` with no prior `C` falls back to
    /// `output_start == command_line`.
    pub fn push(&mut self, marker: Marker, line: u32, exit: Option<i32>) {
        match marker {
            // PromptStart pins the command line; CommandStart only fills it in
            // if no PromptStart was seen for this block.
            Marker::PromptStart => self.current.command_line = Some(line),
            Marker::CommandStart => {
                self.current.command_line.get_or_insert(line);
            }
            Marker::OutputStart => self.current.output_start = Some(line),
            Marker::CommandEnd => {
                if self.current.is_empty() {
                    // No open block — ignore the stray end marker.
                    return;
                }
                let command_line = self.current.command_line.unwrap_or(line);
                let output_start = self.current.output_start.unwrap_or(command_line);
                self.blocks.push(Block {
                    command_line,
                    output_start,
                    output_end: line,
                    exit,
                });
                self.current = InProgress::default();
            }
        }
    }

    /// Completed blocks in observation order.
    #[must_use]
    pub fn blocks(&self) -> &[Block] {
        &self.blocks
    }
}

#[cfg(test)]
mod tests {
    use super::{Block, Marker, OscBlocks};

    #[test]
    fn single_full_sequence_yields_one_block() {
        let mut osc = OscBlocks::new();
        osc.push(Marker::PromptStart, 0, None);
        osc.push(Marker::OutputStart, 1, None);
        osc.push(Marker::CommandEnd, 3, Some(0));

        assert_eq!(
            osc.blocks(),
            &[Block {
                command_line: 0,
                output_start: 1,
                output_end: 3,
                exit: Some(0),
            }]
        );
    }

    #[test]
    fn two_full_sequences_yield_two_blocks() {
        let mut osc = OscBlocks::new();
        osc.push(Marker::PromptStart, 0, None);
        osc.push(Marker::OutputStart, 1, None);
        osc.push(Marker::CommandEnd, 3, Some(0));
        osc.push(Marker::PromptStart, 4, None);
        osc.push(Marker::OutputStart, 5, None);
        osc.push(Marker::CommandEnd, 9, Some(1));

        assert_eq!(
            osc.blocks(),
            &[
                Block {
                    command_line: 0,
                    output_start: 1,
                    output_end: 3,
                    exit: Some(0),
                },
                Block {
                    command_line: 4,
                    output_start: 5,
                    output_end: 9,
                    exit: Some(1),
                },
            ]
        );
    }

    #[test]
    fn command_end_with_no_open_block_is_ignored() {
        let mut osc = OscBlocks::new();
        osc.push(Marker::CommandEnd, 2, Some(0));
        assert_eq!(osc.blocks(), []);
    }

    #[test]
    fn command_start_fills_in_when_no_prompt_start() {
        let mut osc = OscBlocks::new();
        osc.push(Marker::CommandStart, 2, None);
        osc.push(Marker::OutputStart, 3, None);
        osc.push(Marker::CommandEnd, 5, None);

        assert_eq!(
            osc.blocks(),
            &[Block {
                command_line: 2,
                output_start: 3,
                output_end: 5,
                exit: None,
            }]
        );
    }

    #[test]
    fn prompt_start_wins_over_later_command_start() {
        let mut osc = OscBlocks::new();
        osc.push(Marker::PromptStart, 0, None);
        osc.push(Marker::CommandStart, 1, None);
        osc.push(Marker::OutputStart, 2, None);
        osc.push(Marker::CommandEnd, 4, Some(0));

        assert_eq!(osc.blocks()[0].command_line, 0);
    }

    #[test]
    fn missing_output_start_falls_back_to_command_line() {
        let mut osc = OscBlocks::new();
        osc.push(Marker::PromptStart, 7, None);
        osc.push(Marker::CommandEnd, 9, Some(0));

        assert_eq!(
            osc.blocks(),
            &[Block {
                command_line: 7,
                output_start: 7,
                output_end: 9,
                exit: Some(0),
            }]
        );
    }
}
