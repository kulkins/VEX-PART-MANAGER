// Curated list of common VEX V5 / EDR parts with search links.
// The classifier picks the best-fit entry for a detected geometry, and we
// provide search URLs (not direct SKU URLs) so the user lands on a result
// page even if VEX/Robosource rotate their part numbers.

const VEX_SEARCH = (q) =>
  `https://www.vexrobotics.com/catalogsearch/result/?q=${encodeURIComponent(q)}`;
const ROBO_SEARCH = (q) =>
  `https://www.robosource.net/search?type=product&q=${encodeURIComponent(q)}`;

export const CATEGORIES = {
  structure: {
    id: "structure",
    label: "Structure",
    color: "#6ee7ff",
    description: "C-channels, L-channels, plates and rails",
  },
  motion: {
    id: "motion",
    label: "Motion",
    color: "#b07cff",
    description: "Shafts, gears, sprockets, wheels and bearings",
  },
  hardware: {
    id: "hardware",
    label: "Hardware",
    color: "#ffd76e",
    description: "Screws, nuts, standoffs and spacers",
  },
  electronics: {
    id: "electronics",
    label: "Electronics",
    color: "#6effb1",
    description: "Brain, motors, sensors and battery",
  },
  pneumatics: {
    id: "pneumatics",
    label: "Pneumatics",
    color: "#ff9d6e",
    description: "Cylinders, reservoirs and fittings",
  },
  unknown: {
    id: "unknown",
    label: "Unidentified",
    color: "#8b95b8",
    description: "Geometries that did not match a known part",
  },
};

// Each part has a "match" function evaluated against geometry features.
// The classifier picks the part with the highest match score. The score is
// a confidence in [0, 1].
export const PARTS = [
  // ---------- Structure: c-channels (1x2, 1x3, 1x4, 1x5) ----------
  {
    id: "c-channel-1x2",
    name: "1x2x1x35 C-Channel",
    category: "structure",
    keywords: ["c-channel 1x2x1x35"],
    vexUrl: VEX_SEARCH("c-channel 1x2x1x35"),
    roboUrl: ROBO_SEARCH("c-channel 1x2"),
    // Geometry hints: long, narrow, ~0.5" tall (one VEX hole pitch),
    // medium dim ~1" (two pitch). Length is variable.
    inchProfile: { minor: [0.4, 0.7], mid: [0.85, 1.2], long: [3, 36] },
  },
  {
    id: "c-channel-1x3",
    name: "1x3x1x35 C-Channel",
    category: "structure",
    keywords: ["c-channel 1x3x1x35"],
    vexUrl: VEX_SEARCH("c-channel 1x3x1x35"),
    roboUrl: ROBO_SEARCH("c-channel 1x3"),
    inchProfile: { minor: [0.4, 0.7], mid: [1.35, 1.7], long: [3, 36] },
  },
  {
    id: "c-channel-1x4",
    name: "1x4x1x35 C-Channel",
    category: "structure",
    keywords: ["c-channel 1x4x1x35"],
    vexUrl: VEX_SEARCH("c-channel 1x4x1x35"),
    roboUrl: ROBO_SEARCH("c-channel 1x4"),
    inchProfile: { minor: [0.4, 0.7], mid: [1.85, 2.2], long: [3, 36] },
  },
  {
    id: "c-channel-1x5",
    name: "1x5x1x35 C-Channel",
    category: "structure",
    keywords: ["c-channel 1x5x1x35"],
    vexUrl: VEX_SEARCH("c-channel 1x5x1x35"),
    roboUrl: ROBO_SEARCH("c-channel 1x5"),
    inchProfile: { minor: [0.4, 0.7], mid: [2.35, 2.7], long: [3, 36] },
  },

  // ---------- L-channels ----------
  {
    id: "l-channel-2x2",
    name: "2x2x1x35 Angle (L-Channel)",
    category: "structure",
    keywords: ["angle 2x2x1x35"],
    vexUrl: VEX_SEARCH("angle 2x2x1x35"),
    roboUrl: ROBO_SEARCH("angle 2x2"),
    inchProfile: { minor: [0.4, 0.7], mid: [0.85, 1.2], long: [3, 36] },
  },

  // ---------- Flat plates ----------
  {
    id: "plate-flat",
    name: "Flat Aluminum Plate",
    category: "structure",
    keywords: ["aluminum plate flat bar"],
    vexUrl: VEX_SEARCH("aluminum plate"),
    roboUrl: ROBO_SEARCH("flat plate"),
    inchProfile: { minor: [0.04, 0.2], mid: [0.45, 6], long: [1, 36] },
  },

  // ---------- Motion: square shafts ----------
  {
    id: "shaft-1-8",
    name: "1/8\" Square Shaft",
    category: "motion",
    keywords: ["1/8 square shaft"],
    vexUrl: VEX_SEARCH("1/8 square shaft"),
    roboUrl: ROBO_SEARCH("square shaft"),
    inchProfile: { minor: [0.1, 0.18], mid: [0.1, 0.18], long: [1, 24] },
  },
  // VEX "high strength" shafts are 1/4" hex on the V5 line, but commonly
  // referred to as the 1/4" shaft.
  {
    id: "shaft-1-4",
    name: "1/4\" High Strength Shaft",
    category: "motion",
    keywords: ["1/4 high strength shaft"],
    vexUrl: VEX_SEARCH("high strength shaft"),
    roboUrl: ROBO_SEARCH("high strength shaft"),
    inchProfile: { minor: [0.2, 0.32], mid: [0.2, 0.32], long: [1, 24] },
  },

  // ---------- Motion: gears ----------
  {
    id: "gear-12t",
    name: "12-Tooth Pinion Gear",
    category: "motion",
    keywords: ["12 tooth gear"],
    vexUrl: VEX_SEARCH("12 tooth gear"),
    roboUrl: ROBO_SEARCH("12 tooth gear"),
    inchProfile: { minor: [0.15, 0.45], mid: [0.5, 1.1], long: [0.5, 1.1] },
    isDisc: true,
  },
  {
    id: "gear-36t",
    name: "36-Tooth Gear",
    category: "motion",
    keywords: ["36 tooth gear"],
    vexUrl: VEX_SEARCH("36 tooth gear"),
    roboUrl: ROBO_SEARCH("36 tooth gear"),
    inchProfile: { minor: [0.15, 0.45], mid: [1.4, 2.0], long: [1.4, 2.0] },
    isDisc: true,
  },
  {
    id: "gear-60t",
    name: "60-Tooth Gear",
    category: "motion",
    keywords: ["60 tooth gear"],
    vexUrl: VEX_SEARCH("60 tooth gear"),
    roboUrl: ROBO_SEARCH("60 tooth gear"),
    inchProfile: { minor: [0.15, 0.45], mid: [2.3, 3.1], long: [2.3, 3.1] },
    isDisc: true,
  },
  {
    id: "gear-84t",
    name: "84-Tooth Gear",
    category: "motion",
    keywords: ["84 tooth gear"],
    vexUrl: VEX_SEARCH("84 tooth gear"),
    roboUrl: ROBO_SEARCH("84 tooth gear"),
    inchProfile: { minor: [0.15, 0.45], mid: [3.3, 4.4], long: [3.3, 4.4] },
    isDisc: true,
  },

  // ---------- Motion: wheels ----------
  {
    id: "wheel-275",
    name: '2.75" Omni Wheel',
    category: "motion",
    keywords: ['2.75" omni wheel'],
    vexUrl: VEX_SEARCH("2.75 omni wheel"),
    roboUrl: ROBO_SEARCH("2.75 omni wheel"),
    inchProfile: { minor: [0.7, 1.4], mid: [2.4, 3.1], long: [2.4, 3.1] },
    isDisc: true,
  },
  {
    id: "wheel-4",
    name: '4" Omni Wheel',
    category: "motion",
    keywords: ['4" omni wheel'],
    vexUrl: VEX_SEARCH("4 omni wheel"),
    roboUrl: ROBO_SEARCH("4 omni wheel"),
    inchProfile: { minor: [0.7, 1.5], mid: [3.7, 4.3], long: [3.7, 4.3] },
    isDisc: true,
  },

  // ---------- Motion: sprockets ----------
  {
    id: "sprocket-24t",
    name: "24-Tooth Sprocket",
    category: "motion",
    keywords: ["24 tooth sprocket"],
    vexUrl: VEX_SEARCH("24 tooth sprocket"),
    roboUrl: ROBO_SEARCH("sprocket"),
    inchProfile: { minor: [0.1, 0.35], mid: [1.7, 2.2], long: [1.7, 2.2] },
    isDisc: true,
  },

  // ---------- Hardware: standoffs / spacers ----------
  {
    id: "standoff",
    name: "Aluminum Standoff",
    category: "hardware",
    keywords: ["standoff"],
    vexUrl: VEX_SEARCH("standoff"),
    roboUrl: ROBO_SEARCH("standoff"),
    inchProfile: { minor: [0.2, 0.42], mid: [0.2, 0.42], long: [0.4, 4.0] },
    isCylinder: true,
  },
  {
    id: "spacer",
    name: "Nylon Spacer",
    category: "hardware",
    keywords: ["spacer"],
    vexUrl: VEX_SEARCH("nylon spacer"),
    roboUrl: ROBO_SEARCH("spacer"),
    inchProfile: { minor: [0.1, 0.3], mid: [0.1, 0.3], long: [0.04, 0.6] },
    isCylinder: true,
  },

  // ---------- Hardware: screws ----------
  {
    id: "screw",
    name: "8-32 Screw",
    category: "hardware",
    keywords: ["8-32 screw"],
    vexUrl: VEX_SEARCH("8-32 screw"),
    roboUrl: ROBO_SEARCH("8-32 screw"),
    inchProfile: { minor: [0.08, 0.2], mid: [0.08, 0.2], long: [0.18, 2.2] },
  },
  {
    id: "keps-nut",
    name: "8-32 Keps Nut",
    category: "hardware",
    keywords: ["keps nut"],
    vexUrl: VEX_SEARCH("keps nut"),
    roboUrl: ROBO_SEARCH("keps nut"),
    inchProfile: { minor: [0.06, 0.2], mid: [0.25, 0.45], long: [0.25, 0.45] },
  },

  // ---------- Electronics ----------
  {
    id: "v5-motor",
    name: "V5 Smart Motor",
    category: "electronics",
    keywords: ["v5 smart motor"],
    vexUrl: VEX_SEARCH("v5 smart motor"),
    roboUrl: ROBO_SEARCH("v5 smart motor"),
    inchProfile: { minor: [1.4, 2.2], mid: [1.4, 2.4], long: [2.2, 3.5] },
  },
  {
    id: "v5-brain",
    name: "V5 Robot Brain",
    category: "electronics",
    keywords: ["v5 robot brain"],
    vexUrl: VEX_SEARCH("v5 brain"),
    roboUrl: ROBO_SEARCH("v5 brain"),
    inchProfile: { minor: [1.0, 1.8], mid: [4.4, 5.6], long: [4.4, 5.6] },
  },
  {
    id: "v5-battery",
    name: "V5 Robot Battery",
    category: "electronics",
    keywords: ["v5 battery"],
    vexUrl: VEX_SEARCH("v5 battery"),
    roboUrl: ROBO_SEARCH("v5 battery"),
    inchProfile: { minor: [0.6, 1.4], mid: [1.5, 2.6], long: [4.0, 6.0] },
  },

  // ---------- Pneumatics ----------
  {
    id: "pneumatic-cylinder",
    name: "Pneumatic Cylinder",
    category: "pneumatics",
    keywords: ["pneumatic cylinder"],
    vexUrl: VEX_SEARCH("pneumatic cylinder"),
    roboUrl: ROBO_SEARCH("pneumatic cylinder"),
    inchProfile: { minor: [0.5, 1.0], mid: [0.5, 1.0], long: [2, 6] },
    isCylinder: true,
  },
];

export function findPartById(id) {
  return PARTS.find((p) => p.id === id);
}

export function getCategory(id) {
  return CATEGORIES[id] || CATEGORIES.unknown;
}

export function buildBulkVexUrl(items) {
  // VEX has no public bulk-cart endpoint, so we search for the
  // concatenated keyword list which usually surfaces all matches.
  const q = items.map((i) => i.name).join(" ");
  return VEX_SEARCH(q);
}

export function buildBulkRoboUrl(items) {
  const q = items.map((i) => i.name).join(" ");
  return ROBO_SEARCH(q);
}
