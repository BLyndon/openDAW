pub mod analyser;
pub mod complex;
pub mod realfft;
pub mod reverted;
pub mod rfft;
pub mod signalsmith;

use crate::RealFft;

/// How an option enters the evaluation: baselines set the gates, candidates must pass them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Role {
    Baseline,
    Candidate
}

pub struct Entry {
    pub name: &'static str,
    pub role: Role,
    /// A full N-point complex transform: one call can carry two real channels (`re` and `im`), as
    /// `SignalsmithStretch` does. A real transform needs one call per channel.
    pub complex: bool,
    pub create: fn(usize) -> Box<dyn RealFft>
}

fn create<T: RealFft + 'static>(n: usize) -> Box<dyn RealFft> {
    Box::new(T::new(n))
}

/// Every option the harness measures. The Day-2 prototype joins `realfft` as `Role::Candidate`.
pub const ALL: [Entry; 5] = [
    Entry { name: "analyser", role: Role::Baseline, complex: true, create: create::<analyser::AnalyserFft> },
    Entry { name: "rfft", role: Role::Baseline, complex: false, create: create::<rfft::RfftOption> },
    Entry { name: "signalsmith", role: Role::Baseline, complex: true, create: create::<signalsmith::SignalsmithFft> },
    Entry { name: "reverted", role: Role::Baseline, complex: true, create: create::<reverted::RevertedFft> },
    Entry { name: "realfft", role: Role::Candidate, complex: false, create: create::<realfft::RealFftOption> }
];
