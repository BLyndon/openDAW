pub mod analyser;
pub mod complex;
pub mod realfft;
pub mod reverted;
pub mod rfft;
pub mod signalsmith;

use crate::RealFft;

/// How an option enters the evaluation: baselines set the gates, the reference shows what is reachable,
/// candidates must pass the gates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Role {
    Baseline,
    Reference,
    Candidate
}

pub struct Entry {
    pub name: &'static str,
    pub role: Role,
    pub create: fn(usize) -> Box<dyn RealFft>
}

fn create<T: RealFft + 'static>(n: usize) -> Box<dyn RealFft> {
    Box::new(T::new(n))
}

/// Every option the harness measures. The Day-2 prototype joins here as `Role::Candidate`.
pub const ALL: [Entry; 5] = [
    Entry { name: "analyser", role: Role::Baseline, create: create::<analyser::AnalyserFft> },
    Entry { name: "rfft", role: Role::Baseline, create: create::<rfft::RfftOption> },
    Entry { name: "signalsmith", role: Role::Baseline, create: create::<signalsmith::SignalsmithFft> },
    Entry { name: "reverted", role: Role::Baseline, create: create::<reverted::RevertedFft> },
    Entry { name: "realfft", role: Role::Reference, create: create::<realfft::RealFftOption> }
];
