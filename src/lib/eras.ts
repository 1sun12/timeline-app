// Optional reference markers drawn on the timeline, toggled in Settings.
// Spans are bands with a start and end; events are single points.
// Deep-time dates are "Ma" (millions of years before 1950), converted to the
// axis's astronomical years. Geologic boundaries follow the International
// Chronostratigraphic Chart (ICS v2023/09).
import { toAstro } from "./time";

export interface Marker {
  name: string;
  start: number; // axis value (astronomical years)
  end?: number; // omitted for a single event
  note?: string;
}

export interface MarkerSet {
  id: string;
  name: string;
  description: string;
  markers: Marker[];
}

/** Millions of years before present (1950). */
const ma = (m: number) => 1950 - m * 1e6;
/** Thousands of years before present (1950). */
const ka = (k: number) => 1950 - k * 1e3;
/** A historical year (negative = BCE). */
const yr = (y: number) => toAstro(y);
const NOW = new Date().getFullYear() + 1;

export const MARKER_SETS: MarkerSet[] = [
  {
    id: "cosmic",
    name: "Cosmic history",
    description: "The Big Bang, the Sun and Earth forming, the first life",
    markers: [
      { name: "Big Bang", start: ma(13787) },
      { name: "Solar System forms", start: ma(4567) },
      { name: "Earth forms", start: ma(4540) },
      { name: "Moon forms", start: ma(4510) },
      { name: "Earliest evidence of life", start: ma(3700) },
    ],
  },
  {
    id: "geologic",
    name: "Geologic time",
    description: "Eons, and the periods of the last 539 million years",
    markers: [
      { name: "Hadean", start: ma(4567), end: ma(4031) },
      { name: "Archean", start: ma(4031), end: ma(2500) },
      { name: "Proterozoic", start: ma(2500), end: ma(538.8) },
      { name: "Cambrian", start: ma(538.8), end: ma(485.4) },
      { name: "Ordovician", start: ma(485.4), end: ma(443.8) },
      { name: "Silurian", start: ma(443.8), end: ma(419.2) },
      { name: "Devonian", start: ma(419.2), end: ma(358.9) },
      { name: "Carboniferous", start: ma(358.9), end: ma(298.9) },
      { name: "Permian", start: ma(298.9), end: ma(251.902) },
      { name: "Triassic", start: ma(251.902), end: ma(201.4) },
      { name: "Jurassic", start: ma(201.4), end: ma(145) },
      { name: "Cretaceous", start: ma(145), end: ma(66) },
      { name: "Paleogene", start: ma(66), end: ma(23.03) },
      { name: "Neogene", start: ma(23.03), end: ma(2.58) },
      { name: "Quaternary", start: ma(2.58), end: NOW },
    ],
  },
  {
    id: "dinosaurs",
    name: "Age of dinosaurs",
    description: "Triassic, Jurassic and Cretaceous, from the first dinosaurs to the asteroid",
    markers: [
      { name: "Triassic", start: ma(251.902), end: ma(201.4) },
      { name: "Jurassic", start: ma(201.4), end: ma(145) },
      { name: "Cretaceous", start: ma(145), end: ma(66) },
      { name: "First dinosaurs", start: ma(233), note: "approximate" },
      { name: "Chicxulub impact", start: ma(66) },
    ],
  },
  {
    id: "extinctions",
    name: "Mass extinctions",
    description: "The big five",
    markers: [
      { name: "End-Ordovician", start: ma(443.8) },
      { name: "Late Devonian", start: ma(372) },
      { name: "End-Permian", start: ma(251.902) },
      { name: "End-Triassic", start: ma(201.4) },
      { name: "End-Cretaceous", start: ma(66) },
    ],
  },
  {
    id: "human",
    name: "Human prehistory",
    description: "From the genus Homo to the first writing",
    markers: [
      { name: "Genus Homo", start: ma(2.8), note: "approximate" },
      { name: "Homo sapiens", start: ka(300), note: "approximate" },
      { name: "Farming begins", start: yr(-10000), note: "approximate" },
      { name: "Writing", start: yr(-3200), note: "approximate" },
    ],
  },
  {
    id: "ages",
    name: "Historical ages",
    description: "Bronze Age to the Modern era (conventional, Western-centred)",
    markers: [
      { name: "Bronze Age", start: yr(-3300), end: yr(-1200), note: "approximate; varies by region" },
      { name: "Iron Age", start: yr(-1200), end: yr(-500), note: "approximate; varies by region" },
      { name: "Classical antiquity", start: yr(-800), end: yr(476) },
      { name: "Middle Ages", start: yr(476), end: yr(1500) },
      { name: "Early modern", start: yr(1500), end: yr(1800) },
      { name: "Modern", start: yr(1800), end: NOW },
    ],
  },
];
