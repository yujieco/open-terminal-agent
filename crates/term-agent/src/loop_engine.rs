// Copyright 2026 yujieco
// SPDX-License-Identifier: Apache-2.0

//! Observe -> Reason -> Act -> Verify state machine and its step budget.

use serde::{Deserialize, Serialize};

use crate::error::{AgentError, Result};

/// Steps of one agent iteration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoopPhase {
    /// Read the shadow screen and session state.
    #[default]
    Observe,
    /// Ask the model what to do next.
    Reason,
    /// Run the chosen tool, usually `execute_command`.
    Act,
    /// Check the screen, exit code or prompt to confirm the step worked.
    Verify,
}

/// Hard ceiling on tool-executing iterations for one task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepBudget {
    max_steps: u32,
    used: u32,
}

impl StepBudget {
    /// Creates a budget of at least one step.
    pub fn new(max_steps: u32) -> Self {
        Self {
            max_steps: max_steps.max(1),
            used: 0,
        }
    }

    /// Steps already consumed.
    pub fn used(&self) -> u32 {
        self.used
    }

    /// Configured ceiling.
    pub fn max_steps(&self) -> u32 {
        self.max_steps
    }

    /// Steps left before the loop must stop.
    pub fn remaining(&self) -> u32 {
        self.max_steps.saturating_sub(self.used)
    }

    /// Consumes one step or reports that the ceiling was reached.
    pub fn consume(&mut self) -> Result<()> {
        if self.used >= self.max_steps {
            return Err(AgentError::StepBudgetExhausted(self.max_steps));
        }
        self.used += 1;
        Ok(())
    }
}

/// State of one agent task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLoopState {
    task: String,
    phase: LoopPhase,
    budget: StepBudget,
}

impl AgentLoopState {
    /// Starts a task in the `Observe` phase.
    pub fn new(task: impl Into<String>, max_steps: u32) -> Self {
        Self {
            task: task.into(),
            phase: LoopPhase::default(),
            budget: StepBudget::new(max_steps),
        }
    }

    /// Task description shown in the agent panel.
    pub fn task(&self) -> &str {
        &self.task
    }

    /// Current phase.
    pub fn phase(&self) -> LoopPhase {
        self.phase
    }

    /// Budget snapshot.
    pub fn budget(&self) -> &StepBudget {
        &self.budget
    }

    /// Advances one phase, charging one step when a new iteration starts.
    pub fn advance(&mut self) -> Result<LoopPhase> {
        let next = match self.phase {
            LoopPhase::Observe => {
                self.budget.consume()?;
                LoopPhase::Reason
            }
            LoopPhase::Reason => LoopPhase::Act,
            LoopPhase::Act => LoopPhase::Verify,
            LoopPhase::Verify => LoopPhase::Observe,
        };
        self.phase = next;
        Ok(next)
    }

    /// Returns to `Observe` without resetting the spent budget, used after an
    /// approval or a take-over so the loop re-reads reality before acting.
    pub fn reobserve(&mut self) -> LoopPhase {
        self.phase = LoopPhase::Observe;
        self.phase
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_cycle_in_order() {
        let mut state = AgentLoopState::new("upgrade firmware", 3);
        assert_eq!(state.phase(), LoopPhase::Observe);
        assert_eq!(state.advance().expect("reason"), LoopPhase::Reason);
        assert_eq!(state.advance().expect("act"), LoopPhase::Act);
        assert_eq!(state.advance().expect("verify"), LoopPhase::Verify);
        assert_eq!(state.advance().expect("observe"), LoopPhase::Observe);
    }

    #[test]
    fn budget_stops_the_loop_after_the_ceiling() {
        let mut state = AgentLoopState::new("inspect", 2);
        assert_eq!(state.budget().remaining(), 2);

        // One full cycle charges exactly one step, at Observe -> Reason.
        state.advance().expect("observe -> reason");
        state.advance().expect("reason -> act");
        state.advance().expect("act -> verify");
        state.advance().expect("verify -> observe");
        assert_eq!(state.budget().used(), 1);

        state.advance().expect("observe -> reason");
        state.advance().expect("reason -> act");
        state.advance().expect("act -> verify");
        state.advance().expect("verify -> observe");
        assert_eq!(state.budget().used(), 2);
        assert_eq!(state.budget().remaining(), 0);

        assert!(matches!(
            state.advance(),
            Err(AgentError::StepBudgetExhausted(2))
        ));
    }

    #[test]
    fn reobserve_keeps_spent_steps() {
        let mut state = AgentLoopState::new("inspect", 5);
        state.advance().expect("step");
        let used = state.budget().used();
        assert_eq!(state.reobserve(), LoopPhase::Observe);
        assert_eq!(state.budget().used(), used);
    }
}
