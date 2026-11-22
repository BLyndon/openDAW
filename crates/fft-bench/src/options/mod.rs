pub mod analyser;
pub mod complex;
pub mod outlook;
pub mod realfft;
pub mod reverted;
pub mod rfft;
pub mod signalsmith;
pub mod simd;

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

/// Every option the harness measures.
pub const ALL: [Entry; 8] = [
    Entry { name: "analyser", role: Role::Baseline, complex: true, create: create::<analyser::AnalyserFft> },
    Entry { name: "rfft", role: Role::Baseline, complex: false, create: create::<rfft::RfftOption> },
    Entry { name: "signalsmith", role: Role::Baseline, complex: true, create: create::<signalsmith::SignalsmithFft> },
    Entry { name: "reverted", role: Role::Baseline, complex: true, create: create::<reverted::RevertedFft> },
    Entry { name: "realfft", role: Role::Candidate, complex: false, create: create::<realfft::RealFftOption> },
    Entry { name: "simd", role: Role::Candidate, complex: false, create: create::<simd::SimdRealFft> },
    Entry { name: "simd-complex", role: Role::Candidate, complex: true, create: create::<simd::SimdComplexFft> },
    Entry { name: "simd-o1o4", role: Role::Candidate, complex: false, create: create::<outlook::Selection> }
];
