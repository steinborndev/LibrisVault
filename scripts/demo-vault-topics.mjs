/**
 * The subject matter behind the demo vault - titles only, no real notes.
 *
 * Split out of `demo-vault.mjs` because a vault that shows what the platform is for has to be
 * the size of a real one, and that is a lot of page titles. They are hand-written rather than
 * generated: the TITLE is what a screenshot actually shows - graph labels, library rows,
 * citation chips - so it has to read like something a person would keep notes on. The page
 * BODIES are assembled from templates in the generator; nobody screenshots a page body.
 *
 * The shape follows how a personal wiki really grows (re-measured 2026-09-25 against a real
 * vault of about 1,350 knowledge pages over 25 domains): one subject you are deep in, a
 * handful you dip into, and a long tail of one-afternoon detours. A flat distribution across
 * domains looks synthetic at a glance, which is exactly what these images must not look like.
 *
 * Each domain is cut into AREAS, the sub-subjects notes on it cluster into. An area's first
 * concept is its hub, the page the rest of the area leads back to, and the first area's hub
 * is the page the whole domain leads back to; the generator links accordingly, which is what
 * gives the Areas overlay communities to find and the Landmarks overlay pages to rank. The
 * area's `tag` goes on every page in it and is what Areas captions the community with, so it
 * says what the area is about. Entities carry a `kind` (organization, dataset, software, ...)
 * that names what a page IS rather than what it is about, the kind of tag the captions skip.
 *
 * Everything here is textbook subject matter. No real person, organisation, product, mission
 * or source; an entity is an invented descriptor of the kind of body a field has.
 */

export const DOMAINS = {
  astronomy: {
    blurb: 'exoplanets, the instruments that find them, and the stars they orbit',
    tags: ['astronomy', 'exoplanet', 'spectroscopy', 'photometry', 'stellar-physics'],
    areas: [
      { tag: 'transit-detection', concepts: [
        'Transit Photometry', 'Transit Depth', 'Transit Duration', 'Impact Parameter',
        'Limb Darkening', 'Transit Timing Variations', 'Transit Ephemeris', 'Box Least Squares',
        'Candidate Vetting Pipeline', 'False Positive Rate', 'Blended Eclipsing Binary',
        'Centroid Offset Test', 'Detection Efficiency', 'Injection Recovery Test',
      ] },
      { tag: 'phase-curves', concepts: [
        'Phase Curve', 'Secondary Eclipse', 'Occultation Timing', 'Doppler Beaming',
        'Ellipsoidal Variation', 'Emission Spectroscopy', 'Equilibrium Temperature', 'Bond Albedo',
        'Heat Redistribution', 'Thermal Inversion',
      ] },
      { tag: 'radial-velocity', concepts: [
        'Radial Velocity Method', 'Minimum Mass Degeneracy', 'Astrometric Detection',
        'Pulsar Timing', 'Orbital Eccentricity', 'Tidal Circularisation', 'Spin-Orbit Alignment',
        'Rossiter-McLaughlin Effect', 'Obliquity Measurement',
      ] },
      { tag: 'high-contrast-imaging', concepts: [
        'Direct Imaging', 'Adaptive Optics', 'Coronagraph', 'Starshade', 'Point Spread Function',
        'Contrast Curve', 'Speckle Noise',
      ] },
      { tag: 'atmospheric-retrieval', concepts: [
        'Atmospheric Retrieval', 'Atmospheric Transmission Spectroscopy', 'Free Retrieval',
        'Chemical Equilibrium Model', 'Atmospheric Scale Height', 'Molecular Opacity',
        'Atmospheric Metallicity', 'Carbon-to-Oxygen Ratio', 'Atmospheric Escape',
        'Hydrodynamic Escape',
      ] },
      { tag: 'clouds-and-hazes', concepts: [
        'Cloud Deck', 'Photochemical Haze', 'Aerosol Scattering', 'Rayleigh Scattering Slope',
        'Cloud Top Pressure', 'Terminator Asymmetry',
      ] },
      { tag: 'stellar-activity', concepts: [
        'Stellar Activity Noise', 'Starspot Modulation', 'Faculae', 'Chromospheric Emission',
        'Activity Index', 'Convective Blueshift', 'Granulation Noise', 'Magnetic Activity Cycle',
        'Flare Rate', 'Stellar Wind', 'Stellar Rotation Period', 'Lomb-Scargle Periodogram',
        'Gyrochronology',
      ] },
      { tag: 'stellar-characterisation', concepts: [
        'Stellar Isochrone', 'Effective Temperature', 'Surface Gravity', 'Stellar Metallicity',
        'Spectral Type', 'Main Sequence Lifetime', 'Asteroseismology', 'Solar-Like Oscillation',
        'Spectral Energy Distribution', 'Bolometric Correction', 'Cluster Age Dating',
      ] },
      { tag: 'spectrographs', concepts: [
        'Echelle Spectrograph', 'Spectral Resolution', 'Wavelength Calibration',
        'Laser Frequency Comb', 'Fibre Scrambling', 'Thermal Stability', 'Instrumental Drift',
      ] },
      { tag: 'detector-systematics', concepts: [
        'Photometric Precision', 'Flat Fielding', 'Pixel Response Non-Uniformity', 'Dark Current',
        'Readout Noise', 'Charge Transfer Inefficiency', 'Detector Persistence', 'Guiding Jitter',
        'Light Curve Detrending', 'Systematics Removal', 'Wavelet Denoising', 'Signal Averaging',
      ] },
      { tag: 'bayesian-inference', concepts: [
        'Posterior Distribution', 'Markov Chain Monte Carlo', 'Nested Sampling',
        'Bayesian Evidence', 'Model Comparison', 'Gaussian Process Regression', 'Covariance Matrix',
        'Bootstrap Uncertainty', 'Prior Sensitivity', 'Overfitting Diagnostics',
        'Residual Correlation',
      ] },
      { tag: 'planet-formation', concepts: [
        'Protoplanetary Disc', 'Core Accretion', 'Pebble Accretion', 'Gravitational Instability',
        'Snow Line', 'Dust Growth', 'Streaming Instability', 'Planetesimal Formation',
        'Disc Migration', 'Type I Migration', 'Resonance Capture', 'Mean Motion Resonance',
        'Disc Dispersal', 'Photoevaporation', 'Giant Impact', 'Debris Disc',
      ] },
      { tag: 'planet-demographics', concepts: [
        'Occurrence Rate', 'Hot Jupiter', 'Warm Neptune', 'Super-Earth', 'Sub-Neptune',
        'Radius Valley', 'Ultra-Short Period Planet', 'Circumbinary Planet', 'Free-Floating Planet',
        'Gravitational Microlensing', 'Habitable Zone', 'Mass-Radius Relation', 'Bulk Density',
        'Interior Structure Model', 'Core Mass Fraction', 'Envelope Mass Fraction', 'Water World',
        'Lava Planet',
      ] },
      { tag: 'galactic-context', concepts: [
        'Stellar Population', 'Parallax Measurement', 'Proper Motion', 'Galactic Kinematics',
        'Initial Mass Function', 'Binary Fraction', 'Interstellar Extinction', 'Distance Ladder',
        'Standard Candle',
      ] },
    ],
    entities: [
      { title: 'Space-Based Transit Survey', kind: 'organization', area: 'transit-detection' },
      { title: 'Transit Follow-Up Network', kind: 'organization', area: 'transit-detection' },
      { title: 'Light Curve Archive', kind: 'dataset', area: 'transit-detection' },
      { title: 'Planet Candidate Vetting Group', kind: 'organization', area: 'transit-detection' },
      { title: 'Transit Search Pipeline', kind: 'software', area: 'transit-detection' },
      { title: 'Orbiting Infrared Photometer', kind: 'facility', area: 'phase-curves' },
      { title: 'Thermal Phase Curve Programme', kind: 'organization', area: 'phase-curves' },
      { title: 'Eclipse Mapping Working Group', kind: 'organization', area: 'phase-curves' },
      { title: 'Ground-Based Spectrograph Network', kind: 'facility', area: 'radial-velocity' },
      { title: 'Radial Velocity Working Group', kind: 'organization', area: 'radial-velocity' },
      { title: 'Precision Velocity Pipeline', kind: 'software', area: 'radial-velocity' },
      { title: 'Northern Velocity Survey', kind: 'organization', area: 'radial-velocity' },
      { title: 'Adaptive Optics Testbed', kind: 'facility', area: 'high-contrast-imaging' },
      { title: 'High-Contrast Imaging Survey', kind: 'organization', area: 'high-contrast-imaging' },
      { title: 'Extreme Adaptive Optics Instrument', kind: 'instrument', area: 'high-contrast-imaging' },
      { title: 'Speckle Subtraction Toolkit', kind: 'software', area: 'high-contrast-imaging' },
      { title: 'Atmospheric Characterisation Programme', kind: 'organization', area: 'atmospheric-retrieval' },
      { title: 'Open Retrieval Framework', kind: 'software', area: 'atmospheric-retrieval' },
      { title: 'Molecular Line List Database', kind: 'dataset', area: 'atmospheric-retrieval' },
      { title: 'Transmission Spectrum Library', kind: 'dataset', area: 'atmospheric-retrieval' },
      { title: 'Aerosol Optical Constants Database', kind: 'dataset', area: 'clouds-and-hazes' },
      { title: 'Cloud Microphysics Model', kind: 'software', area: 'clouds-and-hazes' },
      { title: 'Haze Laboratory Consortium', kind: 'organization', area: 'clouds-and-hazes' },
      { title: 'Stellar Activity Monitoring Programme', kind: 'organization', area: 'stellar-activity' },
      { title: 'Stellar Flare Catalogue', kind: 'dataset', area: 'stellar-activity' },
      { title: 'Disc-Integrated Solar Telescope', kind: 'instrument', area: 'stellar-activity' },
      { title: 'Stellar Parameter Catalogue', kind: 'dataset', area: 'stellar-characterisation' },
      { title: 'Asteroseismic Mode Catalogue', kind: 'dataset', area: 'stellar-characterisation' },
      { title: 'Stellar Evolution Grid', kind: 'dataset', area: 'stellar-characterisation' },
      { title: 'Spectroscopic Parameter Pipeline', kind: 'software', area: 'stellar-characterisation' },
      { title: 'High-Resolution Spectrograph Consortium', kind: 'organization', area: 'spectrographs' },
      { title: 'Observatory Time Allocation Committee', kind: 'organization', area: 'spectrographs' },
      { title: 'Frequency Comb Calibration Unit', kind: 'instrument', area: 'spectrographs' },
      { title: 'Fibre-Fed Near-Infrared Spectrograph', kind: 'instrument', area: 'spectrographs' },
      { title: 'Wide-Field Photometric Camera', kind: 'instrument', area: 'detector-systematics' },
      { title: 'Detector Calibration Facility', kind: 'facility', area: 'detector-systematics' },
      { title: 'Photometric Standards Network', kind: 'organization', area: 'detector-systematics' },
      { title: 'Pixel-Level Systematics Model', kind: 'software', area: 'detector-systematics' },
      { title: 'Nested Sampling Toolkit', kind: 'software', area: 'bayesian-inference' },
      { title: 'Joint Orbit Fitting Package', kind: 'software', area: 'bayesian-inference' },
      { title: 'Statistical Methods Working Group', kind: 'organization', area: 'bayesian-inference' },
      { title: 'Millimetre Disc Survey', kind: 'organization', area: 'planet-formation' },
      { title: 'Disc Imaging Interferometer', kind: 'facility', area: 'planet-formation' },
      { title: 'Planet Formation Simulation Suite', kind: 'software', area: 'planet-formation' },
      { title: 'Debris Disc Census', kind: 'dataset', area: 'planet-formation' },
      { title: 'Planet Parameter Archive', kind: 'dataset', area: 'planet-demographics' },
      { title: 'Planet Population Synthesis Code', kind: 'software', area: 'planet-demographics' },
      { title: 'Bulge Lensing Survey', kind: 'organization', area: 'planet-demographics' },
      { title: 'Mass-Radius Compilation', kind: 'dataset', area: 'planet-demographics' },
      { title: 'Southern Sky Survey', kind: 'organization', area: 'galactic-context' },
      { title: 'Space Astrometry Mission', kind: 'facility', area: 'galactic-context' },
      { title: 'Open Cluster Membership Catalogue', kind: 'dataset', area: 'galactic-context' },
    ],
  },

  computing: {
    blurb: 'distributed systems, storage engines and the data structures under them',
    tags: ['computing', 'distributed-systems', 'algorithms', 'databases', 'concurrency'],
    areas: [
      { tag: 'consensus', concepts: [
        'Consensus Algorithm', 'Leader Election', 'Log Replication', 'Split Brain', 'Fencing Token',
        'Lease Renewal', 'Membership Change', 'Two-Phase Commit', 'Saga Pattern', 'Vector Clock',
      ] },
      { tag: 'replication', concepts: [
        'Eventual Consistency', 'Quorum Read', 'Read Repair', 'Anti-Entropy', 'Merkle Tree',
        'Hinted Handoff',
      ] },
      { tag: 'partitioning', concepts: [
        'Sharding Strategy', 'Consistent Hashing', 'Rendezvous Hashing', 'Range Partitioning',
        'Hot Partition', 'Rebalancing',
      ] },
      { tag: 'storage-engines', concepts: [
        'Log-Structured Merge Tree', 'Memtable', 'Sorted String Table', 'Compaction Policy',
        'Tombstone', 'Write Amplification', 'Read Amplification', 'Space Amplification',
        'Bloom Filter', 'B-Tree Index', 'Inverted Index', 'Content-Addressed Storage',
        'Copy-on-Write Snapshot', 'Chunking Strategy',
      ] },
      { tag: 'durability', concepts: [
        'Write-Ahead Log', 'Fsync Barrier', 'Group Commit', 'Torn Write', 'Page Cache', 'Direct IO',
      ] },
      { tag: 'transactions', concepts: [
        'Multiversion Concurrency Control', 'Snapshot Isolation', 'Write Skew', 'Phantom Read',
        'Serializable Isolation', 'Optimistic Locking', 'Deadlock Detection', 'Lock Escalation',
      ] },
      { tag: 'resilience', concepts: [
        'Backpressure', 'Load Shedding', 'Rate Limiter', 'Token Bucket', 'Queue Depth',
        'Little\'s Law', 'Tail Latency', 'Head-of-Line Blocking', 'Hedged Request',
        'Circuit Breaker', 'Exponential Backoff', 'Jittered Retry', 'Idempotency Key',
        'Connection Pooling',
      ] },
      { tag: 'caching', concepts: [
        'Cache Eviction Policy', 'Cache Invalidation', 'Cache Stampede', 'Negative Caching',
        'Write-Through Cache', 'Materialised View',
      ] },
      { tag: 'event-streaming', concepts: [
        'Event Sourcing', 'Change Data Capture', 'Outbox Pattern', 'Consumer Offset',
        'Idempotent Consumer', 'Exactly-Once Delivery',
      ] },
    ],
    entities: [
      { title: 'Coordination Service', kind: 'software', area: 'consensus' },
      { title: 'Consensus Library', kind: 'software', area: 'consensus' },
      { title: 'Partition Fault Injection Harness', kind: 'software', area: 'consensus' },
      { title: 'Replicated Document Store', kind: 'software', area: 'replication' },
      { title: 'Object Storage Backend', kind: 'software', area: 'replication' },
      { title: 'Wide-Column Store', kind: 'software', area: 'partitioning' },
      { title: 'Regional Data Centre', kind: 'facility', area: 'partitioning' },
      { title: 'Embedded Key-Value Store', kind: 'software', area: 'storage-engines' },
      { title: 'Full-Text Search Library', kind: 'software', area: 'storage-engines' },
      { title: 'Columnar Storage Format', kind: 'standard', area: 'storage-engines' },
      { title: 'Time-Series Database', kind: 'software', area: 'storage-engines' },
      { title: 'Key-Value Workload Benchmark', kind: 'dataset', area: 'storage-engines' },
      { title: 'Power-Loss Test Rig', kind: 'instrument', area: 'durability' },
      { title: 'Isolation Anomaly Test Suite', kind: 'software', area: 'transactions' },
      { title: 'Database Systems Reading Group', kind: 'organization', area: 'transactions' },
      { title: 'Service Mesh Sidecar', kind: 'software', area: 'resilience' },
      { title: 'Container Scheduler', kind: 'software', area: 'resilience' },
      { title: 'Distributed Tracing Collector', kind: 'software', area: 'resilience' },
      { title: 'Load Generation Toolkit', kind: 'software', area: 'resilience' },
      { title: 'In-Memory Cache Server', kind: 'software', area: 'caching' },
      { title: 'Edge Cache Network', kind: 'facility', area: 'caching' },
      { title: 'Distributed Log Service', kind: 'software', area: 'event-streaming' },
      { title: 'Message Broker', kind: 'software', area: 'event-streaming' },
      { title: 'Stream Processing Framework', kind: 'software', area: 'event-streaming' },
      { title: 'Schema Registry', kind: 'software', area: 'event-streaming' },
    ],
  },

  'machine-learning': {
    blurb: 'how models are trained, evaluated and made to behave',
    tags: ['machine-learning', 'training', 'evaluation', 'representation', 'optimisation'],
    areas: [
      { tag: 'gradient-methods', concepts: [
        'Gradient Descent', 'Learning Rate Schedule', 'Momentum', 'Gradient Clipping',
        'Loss Landscape', 'Cross-Entropy Loss', 'Scaling Law', 'Curriculum Learning',
      ] },
      { tag: 'network-architecture', concepts: [
        'Attention Mechanism', 'Multi-Head Attention', 'Feed-Forward Block', 'Residual Connection',
        'Positional Encoding', 'Layer Normalisation', 'Batch Normalisation', 'Mixture of Experts',
      ] },
      { tag: 'embeddings', concepts: [
        'Embedding Space', 'Cosine Similarity', 'Contrastive Loss', 'Hard Negative Mining',
        'Nearest-Neighbour Search',
      ] },
      { tag: 'overfitting', concepts: [
        'Overfitting', 'Underfitting', 'Bias-Variance Trade-off', 'Double Descent',
        'Regularisation', 'Dropout', 'Weight Decay', 'Early Stopping', 'Label Smoothing',
        'Data Augmentation',
      ] },
      { tag: 'experimental-design', concepts: [
        'Cross-Validation', 'Holdout Set', 'Train-Test Leakage', 'Random Seed Variance',
        'Confidence Interval', 'Ablation Study',
      ] },
      { tag: 'classification-metrics', concepts: [
        'Confusion Matrix', 'Precision and Recall', 'F1 Score', 'ROC Curve', 'Decision Threshold',
        'Class Imbalance', 'Calibration Error',
      ] },
      { tag: 'dataset-shift', concepts: [
        'Distribution Shift', 'Covariate Shift', 'Label Shift', 'Concept Drift',
        'Out-of-Distribution Detection',
      ] },
      { tag: 'benchmarking', concepts: [
        'Evaluation Harness', 'Benchmark Contamination', 'Prompt Sensitivity',
        'Leaderboard Saturation', 'Pairwise Preference Evaluation',
      ] },
      { tag: 'model-compression', concepts: [
        'Quantisation', 'Pruning', 'Knowledge Distillation', 'Low-Rank Factorisation',
      ] },
      { tag: 'transfer-learning', concepts: [
        'Transfer Learning', 'Fine-Tuning', 'Parameter-Efficient Adaptation', 'Instruction Tuning',
        'Catastrophic Forgetting',
      ] },
      { tag: 'reinforcement-learning', concepts: [
        'Reinforcement Learning from Feedback', 'Reward Model', 'Policy Gradient', 'Value Function',
        'KL Penalty', 'Exploration-Exploitation',
      ] },
      { tag: 'language-models', concepts: [
        'Context Window', 'Next-Token Prediction', 'Tokenisation', 'In-Context Learning',
        'Retrieval-Augmented Generation',
      ] },
    ],
    entities: [
      { title: 'Compute Cluster Allocation', kind: 'facility', area: 'gradient-methods' },
      { title: 'Automatic Differentiation Library', kind: 'software', area: 'gradient-methods' },
      { title: 'Reference Transformer Implementation', kind: 'software', area: 'network-architecture' },
      { title: 'Vector Database', kind: 'software', area: 'embeddings' },
      { title: 'Sentence Embedding Benchmark', kind: 'dataset', area: 'embeddings' },
      { title: 'Approximate Neighbour Index Library', kind: 'software', area: 'embeddings' },
      { title: 'Noisy Label Image Corpus', kind: 'dataset', area: 'overfitting' },
      { title: 'Experiment Tracking Service', kind: 'software', area: 'experimental-design' },
      { title: 'Hyperparameter Sweep Scheduler', kind: 'software', area: 'experimental-design' },
      { title: 'Reproducibility Checklist', kind: 'standard', area: 'experimental-design' },
      { title: 'Imbalanced Fraud Detection Corpus', kind: 'dataset', area: 'classification-metrics' },
      { title: 'Temporal Drift Benchmark', kind: 'dataset', area: 'dataset-shift' },
      { title: 'Production Drift Monitor', kind: 'software', area: 'dataset-shift' },
      { title: 'Benchmark Suite', kind: 'dataset', area: 'benchmarking' },
      { title: 'Evaluation Working Group', kind: 'organization', area: 'benchmarking' },
      { title: 'Model Card Registry', kind: 'standard', area: 'benchmarking' },
      { title: 'Held-Out Evaluation Consortium', kind: 'organization', area: 'benchmarking' },
      { title: 'Edge Inference Runtime', kind: 'software', area: 'model-compression' },
      { title: 'Open Model Weights Repository', kind: 'facility', area: 'transfer-learning' },
      { title: 'Open Instruction Corpus', kind: 'dataset', area: 'transfer-learning' },
      { title: 'Annotation Platform', kind: 'software', area: 'reinforcement-learning' },
      { title: 'Preference Comparison Dataset', kind: 'dataset', area: 'reinforcement-learning' },
      { title: 'Simulated Control Environment Suite', kind: 'software', area: 'reinforcement-learning' },
      { title: 'Web-Scale Text Corpus', kind: 'dataset', area: 'language-models' },
      { title: 'Inference Serving Engine', kind: 'software', area: 'language-models' },
    ],
  },

  'climate-science': {
    blurb: 'the carbon cycle, ocean circulation and the proxy record',
    tags: ['climate', 'carbon-cycle', 'paleoclimate', 'ocean', 'modelling'],
    areas: [
      { tag: 'carbon-budget', concepts: [
        'Carbon Cycle', 'Ocean Carbon Sink', 'Biological Pump', 'Solubility Pump',
        'Carbonate Compensation Depth', 'Alkalinity Budget', 'Ocean Acidification',
        'Permafrost Carbon', 'Methane Clathrate', 'Airborne Fraction', 'Carbon Residence Time',
      ] },
      { tag: 'ocean-circulation', concepts: [
        'Thermohaline Circulation', 'Meridional Overturning', 'Upwelling Zone',
        'Sea Surface Temperature Record', 'Deep Water Formation', 'Ocean Heat Uptake',
        'Mixed Layer Depth',
      ] },
      { tag: 'radiative-forcing', concepts: [
        'Radiative Forcing', 'Aerosol Forcing', 'Volcanic Forcing', 'Solar Irradiance Variation',
        'Effective Radiative Forcing', 'Greenhouse Gas Forcing',
      ] },
      { tag: 'climate-feedbacks', concepts: [
        'Climate Sensitivity', 'Feedback Loops', 'Albedo Feedback', 'Cloud Feedback',
        'Water Vapour Feedback', 'Lapse Rate Feedback', 'Transient Climate Response',
        'Tipping Point',
      ] },
      { tag: 'proxy-record', concepts: [
        'Proxy Calibration', 'Ice Core Proxies', 'Isotope Fractionation', 'Speleothem Record',
        'Tree Ring Chronology', 'Varve Counting', 'Radiocarbon Dating', 'Age-Depth Model',
        'Detrital Correction', 'Proxy System Model', 'Milankovitch Cycles',
        'Dansgaard-Oeschger Event', 'Heinrich Event', 'Younger Dryas',
        'Paleocene-Eocene Thermal Maximum',
      ] },
      { tag: 'sea-level', concepts: [
        'Sea Level Reconstruction', 'Ice Sheet Mass Balance', 'Glacial Isostatic Adjustment',
        'Marine Ice Sheet Instability', 'Thermosteric Sea Level Rise',
      ] },
      { tag: 'model-ensembles', concepts: [
        'General Circulation Model', 'Ensemble Spread', 'Downscaling', 'Bias Correction',
        'Emergent Constraint', 'Detection and Attribution', 'Subgrid Parameterisation',
      ] },
    ],
    entities: [
      { title: 'Global Ocean Observing Array', kind: 'instrument', area: 'ocean-circulation' },
      { title: 'Polar Ice Core Archive', kind: 'facility', area: 'proxy-record' },
      { title: 'Coupled Model Comparison Round', kind: 'organization', area: 'model-ensembles' },
      { title: 'Paleoclimate Data Repository', kind: 'dataset', area: 'proxy-record' },
      { title: 'Ocean Time-Series Station', kind: 'facility', area: 'carbon-budget' },
      { title: 'Atmospheric Monitoring Network', kind: 'organization', area: 'radiative-forcing' },
      { title: 'Satellite Altimetry Mission', kind: 'instrument', area: 'sea-level' },
      { title: 'Regional Climate Modelling Group', kind: 'organization', area: 'model-ensembles' },
      { title: 'Continental Flux Tower Network', kind: 'facility', area: 'carbon-budget' },
      { title: 'Underway Carbon Measurement Archive', kind: 'dataset', area: 'carbon-budget' },
      { title: 'Subpolar Mooring Line', kind: 'instrument', area: 'ocean-circulation' },
      { title: 'Hydrographic Section Programme', kind: 'organization', area: 'ocean-circulation' },
      { title: 'Radiation Budget Radiometer', kind: 'instrument', area: 'radiative-forcing' },
      { title: 'Volcanic Aerosol Reconstruction', kind: 'dataset', area: 'radiative-forcing' },
      { title: 'Cloud Process Study Group', kind: 'organization', area: 'climate-feedbacks' },
      { title: 'Feedback Kernel Library', kind: 'dataset', area: 'climate-feedbacks' },
      { title: 'Marine Sediment Core Store', kind: 'facility', area: 'proxy-record' },
      { title: 'Ice Sheet Modelling Consortium', kind: 'organization', area: 'sea-level' },
      { title: 'Tide Gauge Network', kind: 'instrument', area: 'sea-level' },
      { title: 'Model Output Archive', kind: 'dataset', area: 'model-ensembles' },
    ],
  },

  'materials-science': {
    blurb: 'structure, defects and why materials fail',
    tags: ['materials-science', 'crystallography', 'mechanics', 'characterisation', 'failure'],
    areas: [
      { tag: 'crystal-structure', concepts: [
        'Crystal Lattice', 'Unit Cell', 'Miller Indices', 'Anisotropy', 'Texture',
      ] },
      { tag: 'lattice-defects', concepts: [
        'Dislocation', 'Burgers Vector', 'Slip System', 'Vacancy Migration', 'Interstitial Defect',
        'Stacking Fault', 'Twin Boundary', 'Grain Boundary',
      ] },
      { tag: 'phase-transformations', concepts: [
        'Phase Diagram', 'Eutectic Point', 'Solid Solution', 'Martensitic Transformation',
        'Diffusion Coefficient',
      ] },
      { tag: 'heat-treatment', concepts: [
        'Annealing', 'Recrystallisation', 'Work Hardening', 'Precipitation Hardening',
        'Residual Stress',
      ] },
      { tag: 'mechanical-properties', concepts: [
        'Yield Strength', 'Elastic Modulus', 'Poisson Ratio', 'Ultimate Tensile Strength',
        'Ductility', 'Creep Deformation', 'Stress Relaxation',
      ] },
      { tag: 'fracture-and-corrosion', concepts: [
        'Fracture Toughness', 'Crack Propagation', 'Stress Concentration', 'Fatigue Life',
        'Thermal Expansion Mismatch', 'Coating Adhesion', 'Surface Roughness', 'Wear Mechanism',
        'Corrosion Resistance', 'Passivation Layer',
      ] },
    ],
    entities: [
      { title: 'Electron Microscopy Facility', kind: 'facility', area: 'lattice-defects' },
      { title: 'X-Ray Diffraction Laboratory', kind: 'facility', area: 'crystal-structure' },
      { title: 'Mechanical Testing Standard', kind: 'standard', area: 'mechanical-properties' },
      { title: 'Materials Property Database', kind: 'dataset', area: 'mechanical-properties' },
      { title: 'Failure Analysis Working Group', kind: 'organization', area: 'fracture-and-corrosion' },
      { title: 'Reference Diffraction Pattern Set', kind: 'dataset', area: 'crystal-structure' },
      { title: 'Dislocation Dynamics Code', kind: 'software', area: 'lattice-defects' },
      { title: 'Thermodynamic Assessment Database', kind: 'dataset', area: 'phase-transformations' },
      { title: 'Phase Equilibria Calculator', kind: 'software', area: 'phase-transformations' },
      { title: 'Heat Treatment Furnace Hall', kind: 'facility', area: 'heat-treatment' },
      { title: 'Hardness Conversion Table', kind: 'standard', area: 'heat-treatment' },
      { title: 'Nanoindentation Laboratory', kind: 'facility', area: 'mechanical-properties' },
      { title: 'Servo-Hydraulic Fatigue Rig', kind: 'instrument', area: 'fracture-and-corrosion' },
      { title: 'Salt Spray Test Chamber', kind: 'instrument', area: 'fracture-and-corrosion' },
    ],
  },

  cooking: {
    blurb: 'technique, fermentation and why recipes work',
    tags: ['cooking', 'fermentation', 'baking', 'technique', 'food-science'],
    areas: [
      { tag: 'heat-and-browning', concepts: [
        'Maillard Reaction', 'Caramelisation', 'Enzymatic Browning', 'Carryover Cooking',
        'Reverse Searing', 'Sous Vide Equilibrium', 'Fond and Deglazing',
      ] },
      { tag: 'salt-and-protein', concepts: [
        'Denaturation', 'Coagulation', 'Brining', 'Osmosis in Curing', 'Salt Percentage',
        'Dry Aging',
      ] },
      { tag: 'sauces-and-seasoning', concepts: [
        'Emulsification', 'Roux', 'Beurre Monté', 'Reduction', 'Starch Gelatinisation',
        'Acid Balance', 'Umami Layering', 'Mouthfeel',
      ] },
      { tag: 'sugar-work', concepts: [
        'Sugar Stages', 'Crystallisation Control', 'Tempering Chocolate',
      ] },
      { tag: 'dough-and-bread', concepts: [
        'Gluten Development', 'Hydration Ratio', 'Autolyse', 'Leavening Agents', 'Proofing Window',
        'Oven Spring', 'Steam Injection', 'Crumb Structure', 'Lamination',
      ] },
      { tag: 'wild-fermentation', concepts: [
        'Sourdough Fermentation', 'Wild Yeast Culture', 'Lactic Acid Bacteria', 'Preferment',
        'Bulk Fermentation', 'Cold Retardation', 'Koji Cultivation',
      ] },
    ],
    entities: [
      { title: 'Standard Kitchen Reference', kind: 'standard', area: 'heat-and-browning' },
      { title: 'Fermentation Culture Collection', kind: 'facility', area: 'wild-fermentation' },
      { title: 'Regional Cookbook Archive', kind: 'dataset', area: 'salt-and-protein' },
      { title: 'Ingredient Sourcing Guide', kind: 'dataset', area: 'sauces-and-seasoning' },
      { title: 'Baking Percentages Table', kind: 'standard', area: 'dough-and-bread' },
      { title: 'Test Kitchen Collective', kind: 'organization', area: 'heat-and-browning' },
      { title: 'Precision Water Bath', kind: 'instrument', area: 'heat-and-browning' },
      { title: 'Curing Chamber', kind: 'facility', area: 'salt-and-protein' },
      { title: 'Charcuterie Guild', kind: 'organization', area: 'salt-and-protein' },
      { title: 'Confectioners\' Temperature Chart', kind: 'standard', area: 'sugar-work' },
      { title: 'Chocolate Tempering Workshop', kind: 'facility', area: 'sugar-work' },
      { title: 'Flour Quality Laboratory', kind: 'facility', area: 'dough-and-bread' },
      { title: 'Community Starter Library', kind: 'organization', area: 'wild-fermentation' },
    ],
  },

  neuroscience: {
    blurb: 'neurons, circuits and the methods used to watch them',
    tags: ['neuroscience', 'electrophysiology', 'imaging', 'plasticity', 'circuits'],
    areas: [
      { tag: 'neuronal-excitability', concepts: [
        'Action Potential', 'Resting Membrane Potential', 'Ion Channel Gating', 'Refractory Period',
        'Axonal Conduction Velocity', 'Myelination', 'Dendritic Integration',
      ] },
      { tag: 'synapses-and-glia', concepts: [
        'Neurotransmitter Release', 'Synaptic Cleft', 'Receptor Desensitisation', 'Neuromodulation',
        'Glial Support', 'Blood-Brain Barrier',
      ] },
      { tag: 'learning-and-memory', concepts: [
        'Synaptic Plasticity', 'Long-Term Potentiation', 'Long-Term Depression', 'Hebbian Learning',
        'Critical Period',
      ] },
      { tag: 'neural-coding', concepts: [
        'Spike Train', 'Firing Rate Coding', 'Temporal Coding', 'Population Vector',
        'Receptive Field', 'Lateral Inhibition', 'Central Pattern Generator',
      ] },
      { tag: 'recording-methods', concepts: [
        'Patch Clamp Recording', 'Multi-Electrode Array', 'Spike Sorting',
        'Signal-to-Noise in Recording', 'Calcium Imaging', 'Optogenetics',
        'Functional Magnetic Resonance', 'Haemodynamic Response', 'Event-Related Potential',
        'Connectomics',
      ] },
    ],
    entities: [
      { title: 'Brain Atlas Project', kind: 'organization', area: 'recording-methods' },
      { title: 'Electrophysiology Rig', kind: 'instrument', area: 'neuronal-excitability' },
      { title: 'Imaging Core Facility', kind: 'facility', area: 'recording-methods' },
      { title: 'Neural Data Repository', kind: 'dataset', area: 'neural-coding' },
      { title: 'Animal Model Registry', kind: 'dataset', area: 'learning-and-memory' },
      { title: 'Ion Channel Kinetics Library', kind: 'dataset', area: 'neuronal-excitability' },
      { title: 'Compartmental Neuron Simulator', kind: 'software', area: 'neuronal-excitability' },
      { title: 'Synapse Proteomics Consortium', kind: 'organization', area: 'synapses-and-glia' },
      { title: 'Plasticity Working Group', kind: 'organization', area: 'learning-and-memory' },
      { title: 'Visual Stimulus Library', kind: 'dataset', area: 'neural-coding' },
      { title: 'Spike Sorting Toolkit', kind: 'software', area: 'recording-methods' },
    ],
  },

  ecology: {
    blurb: 'populations, food webs and how ecosystems recover',
    tags: ['ecology', 'populations', 'food-webs', 'biodiversity', 'restoration'],
    areas: [
      { tag: 'trophic-structure', concepts: [
        'Food Web', 'Trophic Cascade', 'Keystone Species', 'Predator-Prey Cycle',
        'Trophic Efficiency', 'Apex Predator', 'Detritus Pathway',
      ] },
      { tag: 'population-growth', concepts: [
        'Carrying Capacity', 'Logistic Growth', 'Density Dependence', 'Metapopulation',
        'Minimum Viable Population', 'Dispersal Kernel',
      ] },
      { tag: 'community-assembly', concepts: [
        'Ecological Niche', 'Competitive Exclusion', 'Niche Partitioning', 'Species Richness',
        'Species-Area Relationship', 'Invasive Species',
      ] },
      { tag: 'succession', concepts: [
        'Ecological Succession', 'Disturbance Regime', 'Ecological Resilience',
        'Alternative Stable States', 'Regime Shift', 'Soil Seed Bank',
      ] },
      { tag: 'field-survey', concepts: [
        'Mark-Recapture', 'Quadrat Sampling', 'Camera Trapping', 'Environmental DNA',
        'Occupancy Modelling',
      ] },
    ],
    entities: [
      { title: 'Lake Food Web Observatory', kind: 'facility', area: 'trophic-structure' },
      { title: 'Stable Isotope Diet Library', kind: 'dataset', area: 'trophic-structure' },
      { title: 'Bird Ringing Scheme', kind: 'organization', area: 'population-growth' },
      { title: 'Population Viability Toolkit', kind: 'software', area: 'population-growth' },
      { title: 'Species Occurrence Archive', kind: 'dataset', area: 'community-assembly' },
      { title: 'Invasive Species Watch Group', kind: 'organization', area: 'community-assembly' },
      { title: 'Permanent Vegetation Plot Network', kind: 'facility', area: 'succession' },
      { title: 'Native Seed Collection', kind: 'facility', area: 'succession' },
      { title: 'Camera Trap Image Archive', kind: 'dataset', area: 'field-survey' },
      { title: 'Field Survey Protocol', kind: 'standard', area: 'field-survey' },
    ],
  },

  economics: {
    blurb: 'markets, money and the way policy moves them',
    tags: ['economics', 'markets', 'monetary-policy', 'measurement'],
    areas: [
      { tag: 'markets-pricing', concepts: [
        'Supply and Demand', 'Price Elasticity', 'Marginal Cost', 'Opportunity Cost',
        'Comparative Advantage', 'Consumer Surplus', 'Deadweight Loss',
      ] },
      { tag: 'market-failure', concepts: [
        'Market Failure', 'Externality', 'Public Good', 'Information Asymmetry', 'Moral Hazard',
        'Adverse Selection',
      ] },
      { tag: 'monetary-transmission', concepts: [
        'Interest Rate Transmission', 'Yield Curve', 'Money Supply Aggregates', 'Velocity of Money',
        'Fiscal Multiplier', 'Purchasing Power Parity',
      ] },
      { tag: 'economic-statistics', concepts: [
        'Inflation Measurement', 'Real versus Nominal', 'Gini Coefficient', 'Seasonal Adjustment',
      ] },
    ],
    entities: [
      { title: 'National Statistics Office', kind: 'organization', area: 'economic-statistics' },
      { title: 'Central Bank Research Bulletin', kind: 'dataset', area: 'monetary-transmission' },
      { title: 'Household Survey Panel', kind: 'dataset', area: 'economic-statistics' },
      { title: 'Consumer Price Basket', kind: 'dataset', area: 'economic-statistics' },
      { title: 'Regional Trade Flow Tables', kind: 'dataset', area: 'markets-pricing' },
      { title: 'Interbank Rate Setting Panel', kind: 'organization', area: 'monetary-transmission' },
      { title: 'Insurance Claims Microdata', kind: 'dataset', area: 'market-failure' },
      { title: 'Emissions Permit Registry', kind: 'dataset', area: 'market-failure' },
    ],
  },

  cryptography: {
    blurb: 'primitives, protocols and the assumptions under them',
    tags: ['cryptography', 'protocols', 'security', 'primitives'],
    areas: [
      { tag: 'symmetric-encryption', concepts: [
        'Block Cipher', 'Stream Cipher', 'Mode of Operation', 'Authenticated Encryption',
        'Message Authentication Code', 'Nonce Reuse', 'Cryptographic Hash Function',
        'Collision Resistance', 'Key Derivation Function', 'Salt and Pepper',
      ] },
      { tag: 'public-key', concepts: [
        'Public Key Exchange', 'Elliptic Curve Arithmetic', 'Digital Signature',
        'Certificate Chain', 'Forward Secrecy', 'Zero-Knowledge Proof',
      ] },
      { tag: 'implementation-attacks', concepts: [
        'Side-Channel Leakage', 'Constant-Time Comparison', 'Random Number Generation',
        'Entropy Pool', 'Fault Injection Attack',
      ] },
    ],
    entities: [
      { title: 'Standards Body Specification', kind: 'standard', area: 'public-key' },
      { title: 'Reference Implementation Library', kind: 'software', area: 'symmetric-encryption' },
      { title: 'Test Vector Suite', kind: 'dataset', area: 'symmetric-encryption' },
      { title: 'Open Cipher Competition Archive', kind: 'dataset', area: 'symmetric-encryption' },
      { title: 'Public Certificate Log', kind: 'dataset', area: 'public-key' },
      { title: 'Side-Channel Measurement Bench', kind: 'instrument', area: 'implementation-attacks' },
      { title: 'Hardware Entropy Source Module', kind: 'instrument', area: 'implementation-attacks' },
    ],
  },

  photography: {
    blurb: 'optics, sensors and what a photograph physically is',
    tags: ['photography', 'optics', 'sensors', 'colour'],
    areas: [
      { tag: 'lens-optics', concepts: [
        'Depth of Field', 'Circle of Confusion', 'Hyperfocal Distance', 'Diffraction Limit',
        'Lens Aberration', 'Chromatic Aberration', 'Vignetting',
      ] },
      { tag: 'image-sensors', concepts: [
        'Dynamic Range', 'Sensor Quantum Efficiency', 'Signal-to-Noise Ratio', 'Read Noise',
        'Bayer Demosaicing', 'Rolling Shutter Skew',
      ] },
      { tag: 'colour-rendering', concepts: [
        'White Balance', 'Colour Gamut', 'Tone Curve', 'Gamma Encoding',
      ] },
    ],
    entities: [
      { title: 'Colour Profile Standard', kind: 'standard', area: 'colour-rendering' },
      { title: 'Lens Test Chart', kind: 'instrument', area: 'lens-optics' },
      { title: 'Lens Design Patent Index', kind: 'dataset', area: 'lens-optics' },
      { title: 'Sensor Characterisation Bench', kind: 'instrument', area: 'image-sensors' },
      { title: 'Open Raw Sample Library', kind: 'dataset', area: 'image-sensors' },
      { title: 'Photographic Process Archive', kind: 'organization', area: 'colour-rendering' },
    ],
  },

  linguistics: {
    blurb: 'how languages are structured and how they change',
    tags: ['linguistics', 'phonology', 'syntax', 'language-change'],
    areas: [
      { tag: 'sound-systems', concepts: [
        'Phoneme Inventory', 'Allophone', 'Minimal Pair', 'Syllable Structure',
      ] },
      { tag: 'morphosyntax', concepts: [
        'Morpheme', 'Derivational Morphology', 'Inflectional Paradigm', 'Syntactic Constituency',
        'Dependency Grammar',
      ] },
      { tag: 'historical-linguistics', concepts: [
        'Sound Change', 'Comparative Reconstruction', 'Grammaticalisation', 'Loanword Adaptation',
        'Language Contact', 'Isogloss',
      ] },
    ],
    entities: [
      { title: 'Language Documentation Archive', kind: 'organization', area: 'sound-systems' },
      { title: 'Field Recording Kit', kind: 'instrument', area: 'sound-systems' },
      { title: 'Annotated Treebank', kind: 'dataset', area: 'morphosyntax' },
      { title: 'Comparative Corpus', kind: 'dataset', area: 'historical-linguistics' },
      { title: 'Dialect Atlas Survey', kind: 'dataset', area: 'historical-linguistics' },
    ],
  },

  epidemiology: {
    blurb: 'how disease spreads through populations and how studies measure it',
    tags: ['epidemiology', 'public-health', 'biostatistics', 'surveillance'],
    areas: [
      { tag: 'transmission-dynamics', concepts: [
        'Basic Reproduction Number', 'Effective Reproduction Number', 'Serial Interval',
        'Incubation Period', 'Compartmental Model', 'Herd Immunity Threshold', 'Superspreading',
        'Attack Rate',
      ] },
      { tag: 'study-design', concepts: [
        'Cohort Study', 'Case-Control Study', 'Confounding', 'Relative Risk', 'Odds Ratio',
        'Selection Bias',
      ] },
    ],
    entities: [
      { title: 'Notifiable Disease Register', kind: 'dataset', area: 'transmission-dynamics' },
      { title: 'Regional Sentinel Surveillance Network', kind: 'organization', area: 'transmission-dynamics' },
      { title: 'Contact Tracing Survey', kind: 'dataset', area: 'transmission-dynamics' },
      { title: 'Longitudinal Birth Cohort', kind: 'dataset', area: 'study-design' },
      { title: 'Outbreak Investigation Unit', kind: 'organization', area: 'study-design' },
    ],
  },

  geology: {
    blurb: 'rocks, strata and the processes that make and move them',
    tags: ['geology', 'petrology', 'stratigraphy', 'tectonics', 'sedimentology'],
    areas: [
      { tag: 'rock-formation', concepts: [
        'Rock Cycle', 'Igneous Differentiation', 'Metamorphic Grade', 'Sedimentary Diagenesis',
        'Principle of Superposition', 'Unconformity', 'Radiometric Dating',
      ] },
      { tag: 'crustal-deformation', concepts: [
        'Plate Boundary', 'Subduction Zone', 'Seafloor Spreading', 'Isostasy', 'Fault Mechanics',
        'Orogeny',
      ] },
    ],
    entities: [
      { title: 'Regional Core Repository', kind: 'facility', area: 'rock-formation' },
      { title: 'Polarising Petrographic Microscope', kind: 'instrument', area: 'rock-formation' },
      { title: 'Geological Survey Map Series', kind: 'dataset', area: 'crustal-deformation' },
      { title: 'Seismic Monitoring Network', kind: 'organization', area: 'crustal-deformation' },
    ],
  },

  'knowledge-management': {
    blurb: 'how the wiki itself is supposed to work',
    tags: ['knowledge-management', 'llm-wiki', 'method', 'retrieval', 'compounding'],
    areas: [
      { tag: 'wiki-design', concepts: [
        'LLM Wiki Pattern', 'Compounding Knowledge', 'Atomic Note', 'Hot Cache',
        'Contextual Retrieval', 'Domain Registry',
      ] },
      { tag: 'graph-health', concepts: [
        'Link Density', 'Orphan Page', 'Page Authority', 'Stub Threshold', 'Knowledge Gap',
      ] },
    ],
    entities: [
      { title: 'Wiki Skill Suite', kind: 'software', area: 'wiki-design' },
      { title: 'Plain-Text Note Editor', kind: 'software', area: 'wiki-design' },
      { title: 'Wiki Lint Checker', kind: 'software', area: 'graph-health' },
      { title: 'Page Frontmatter Schema', kind: 'standard', area: 'graph-health' },
    ],
  },

  'maritime-history': {
    blurb: 'navigation, trade routes and the ships that ran them',
    tags: ['maritime-history', 'navigation', 'trade', 'shipbuilding'],
    areas: [
      { tag: 'seafaring', concepts: [
        'Dead Reckoning', 'Lunar Distance Method', 'Marine Chronometer', 'Trade Wind Route',
        'Hull Form Evolution', 'Cargo Manifest Practice', 'Port Quarantine',
      ] },
    ],
    entities: [
      { title: 'Admiralty Chart Series', kind: 'dataset', area: 'seafaring' },
      { title: 'Port Customs Ledger Collection', kind: 'dataset', area: 'seafaring' },
    ],
  },

  'music-theory': {
    blurb: 'harmony, rhythm and tuning',
    tags: ['music-theory', 'harmony', 'tuning', 'rhythm'],
    areas: [
      { tag: 'pitch-systems', concepts: [
        'Harmonic Series', 'Equal Temperament', 'Just Intonation', 'Functional Harmony',
        'Voice Leading', 'Modal Interchange', 'Polyrhythm',
      ] },
    ],
    entities: [
      { title: 'Historical Tuning Table', kind: 'dataset', area: 'pitch-systems' },
      { title: 'Chorale Harmonisation Corpus', kind: 'dataset', area: 'pitch-systems' },
    ],
  },

  cartography: {
    blurb: 'projections, generalisation and what a map decides to omit',
    tags: ['cartography', 'projection', 'generalisation', 'geodesy'],
    areas: [
      { tag: 'map-design', concepts: [
        'Map Projection', 'Tissot Indicatrix', 'Geodetic Datum', 'Cartographic Generalisation',
        'Contour Interpolation', 'Label Placement',
      ] },
    ],
    entities: [
      { title: 'National Mapping Agency Series', kind: 'dataset', area: 'map-design' },
      { title: 'Historical Map Collection', kind: 'dataset', area: 'map-design' },
    ],
  },

  typography: {
    blurb: 'type, spacing and legibility',
    tags: ['typography', 'type-design', 'legibility', 'layout'],
    areas: [
      { tag: 'typesetting', concepts: [
        'x-Height', 'Optical Sizing', 'Kerning Pairs', 'Hinting', 'Measure and Leading',
      ] },
    ],
    entities: [
      { title: 'Type Specimen Archive', kind: 'organization', area: 'typesetting' },
    ],
  },

  mycology: {
    blurb: 'fungi, their fruiting bodies and their substrates',
    tags: ['mycology', 'fungi', 'identification', 'foraging'],
    areas: [
      { tag: 'fungal-ecology', concepts: [
        'Mycelial Network', 'Mycorrhizal Association', 'Substrate Colonisation', 'Spore Print',
      ] },
    ],
    entities: [
      { title: 'Regional Fungarium', kind: 'facility', area: 'fungal-ecology' },
    ],
  },

  beekeeping: {
    blurb: 'honey bee colonies, their hives and the seasons of keeping them',
    tags: ['beekeeping', 'apiculture', 'pollination', 'colony-health'],
    areas: [
      { tag: 'colony-management', concepts: [
        'Brood Cycle', 'Swarming Behaviour', 'Queen Rearing', 'Varroa Mite Load',
      ] },
    ],
    entities: [
      { title: 'Regional Apiary Inspection Service', kind: 'organization', area: 'colony-management' },
    ],
  },

  horology: {
    blurb: 'mechanical timekeeping and what keeps a clock honest',
    tags: ['horology', 'clockmaking', 'precision', 'mechanisms'],
    areas: [
      { tag: 'escapement-mechanics', concepts: [
        'Escapement', 'Balance Spring Isochronism', 'Temperature Compensation',
      ] },
    ],
    entities: [
      { title: 'Rate Timing Machine', kind: 'instrument', area: 'escapement-mechanics' },
    ],
  },

  glassmaking: {
    blurb: 'melting, forming and annealing glass',
    tags: ['glassmaking', 'glass', 'furnaces', 'craft'],
    areas: [
      { tag: 'hot-glass-working', concepts: [
        'Batch Composition', 'Working Range Viscosity', 'Annealing Schedule',
      ] },
    ],
    entities: [
      { title: 'Studio Glass Furnace', kind: 'facility', area: 'hot-glass-working' },
    ],
  },

  bookbinding: {
    blurb: 'sewing, covering and conserving the codex',
    tags: ['bookbinding', 'book-arts', 'conservation', 'papermaking'],
    areas: [
      { tag: 'codex-structure', concepts: [
        'Signature Folding', 'Grain Direction', 'Case Binding',
      ] },
    ],
    entities: [
      { title: 'Book Conservation Workshop', kind: 'facility', area: 'codex-structure' },
    ],
  },
  /*
   * The one domain the generator does not populate. It exists so the REAL research runs under
   * `scripts/demo-research/` have a registry entry to file against: their pages carry
   * `domain: oncology`, and a page whose domain is not in the registry is unfiled. Deliberately
   * small - a domain a run opened and nothing else has filled yet is a real state of a vault,
   * and one worth showing.
   */
  oncology: {
    blurb: 'targeted cancer therapeutics, their resistance mechanisms, and the patent landscape around them',
    tags: ['oncology', 'adc', 'targeted-therapy', 'resistance', 'payload'],
    areas: [],
    entities: [],
  },
}

/** Pages linked from somewhere but never written - the backlog the graph surfaces. */
export const GAPS = [
  'Planetary Albedo', 'Stellar Jitter Budget', 'Telluric Correction', 'Barycentric Correction',
  'Limb Brightening', 'Disc Instability Criterion', 'Tidal Locking Timescale',
  'Carbonate Weathering Feedback', 'Meridional Heat Transport', 'Aerosol Indirect Effect',
  'Consistency Model', 'Merge Policy', 'Tombstone Compaction', 'Vector Quantisation',
  'Reward Hacking', 'Grokking', 'Slip Band Formation', 'Hydrogen Embrittlement',
  'Enzymatic Peeling', 'Retrogradation', 'Astrocyte Signalling', 'Dendritic Spine Turnover',
  'Post-Quantum Migration', 'Liquidity Trap', 'Anamorphic Squeeze', 'Vowel Shift Chain',
  'Retrieval Evaluation', 'Link Rot',
]

/** Hand-picked cross-domain links, beside the generated ones: pairs a reader would expect. */
export const CROSS_LINKS = [
  ['Chunking Strategy', 'Contextual Retrieval'],
  ['Inverted Index', 'Contextual Retrieval'],
  ['Embedding Space', 'Contextual Retrieval'],
  ['Content-Addressed Storage', 'Knowledge Gap'],
  ['Bloom Filter', 'Hot Cache'],
  ['Markov Chain Monte Carlo', 'Ensemble Spread'],
  ['Gaussian Process Regression', 'Proxy Calibration'],
  ['Signal Averaging', 'Signal-to-Noise Ratio'],
  ['Isotope Fractionation', 'Spectral Resolution'],
  ['Bayesian Evidence', 'Model Comparison'],
  ['Cross-Validation', 'Injection Recovery Test'],
  ['Distribution Shift', 'Bias Correction'],
  ['Sensor Quantum Efficiency', 'Readout Noise'],
  ['Dynamic Range', 'Detector Persistence'],
  ['Crystal Lattice', 'Diffraction Limit'],
  ['Fatigue Life', 'Crack Propagation'],
  ['Lactic Acid Bacteria', 'Substrate Colonisation'],
  ['Mycorrhizal Association', 'Carbon Cycle'],
  ['Cryptographic Hash Function', 'Merkle Tree'],
  ['Random Number Generation', 'Entropy Pool'],
  ['Yield Curve', 'Interest Rate Transmission'],
  ['Atomic Note', 'Domain Registry'],
  ['Page Authority', 'Link Density'],
  ['Equal Temperament', 'Harmonic Series'],
  ['Map Projection', 'Geodetic Datum'],
  ['Dead Reckoning', 'Marine Chronometer'],
  ['Optical Sizing', 'x-Height'],
  ['Long-Term Potentiation', 'Hebbian Learning'],
  ['Attention Mechanism', 'Context Window'],
  ['Quantisation', 'Knowledge Distillation'],
]

/**
 * Which domains a domain's pages reach into, for the generated cross-domain links (the
 * generator's `P.cross`). Real vaults are not random here: an astronomer's notes reach into
 * statistics and optics, not into bread. One-directional on purpose; a reach from the small
 * domains into the big ones is more common than the reverse.
 */
export const NEIGHBOURS = {
  astronomy: ['machine-learning', 'photography', 'climate-science', 'materials-science'],
  computing: ['machine-learning', 'cryptography', 'knowledge-management', 'economics'],
  'machine-learning': ['computing', 'astronomy', 'neuroscience', 'linguistics', 'knowledge-management'],
  'climate-science': ['ecology', 'geology', 'astronomy', 'economics'],
  'materials-science': ['geology', 'glassmaking', 'photography', 'cooking'],
  cooking: ['mycology', 'ecology', 'materials-science', 'beekeeping'],
  neuroscience: ['machine-learning', 'epidemiology', 'linguistics'],
  ecology: ['climate-science', 'mycology', 'epidemiology', 'beekeeping'],
  economics: ['climate-science', 'computing', 'maritime-history', 'epidemiology'],
  cryptography: ['computing', 'economics'],
  photography: ['astronomy', 'typography', 'materials-science'],
  linguistics: ['machine-learning', 'typography', 'neuroscience'],
  epidemiology: ['ecology', 'economics', 'machine-learning'],
  geology: ['climate-science', 'materials-science', 'cartography'],
  'knowledge-management': ['machine-learning', 'computing', 'typography'],
  'music-theory': ['neuroscience', 'horology'],
  'maritime-history': ['cartography', 'horology', 'economics'],
  cartography: ['geology', 'maritime-history', 'typography'],
  typography: ['bookbinding', 'photography'],
  mycology: ['ecology', 'cooking'],
  beekeeping: ['ecology', 'cooking'],
  horology: ['maritime-history', 'materials-science'],
  glassmaking: ['materials-science', 'photography'],
  bookbinding: ['typography', 'materials-science'],
}
