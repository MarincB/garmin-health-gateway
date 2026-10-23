// Static mobility and strength routines. Plans reference them by id (Session.mobility).
// Conservative, general-purpose exercises. Not medical advice.

export interface Exercise { name: string; dose: string; cue: string }
export interface Routine {
  id: string;
  name: string;
  duration_min: number;
  when: string;
  exercises: Exercise[];
}

export const ROUTINES: Routine[] = [
  {
    id: "itb-hip-mobility",
    name: "Hip mobility for IT band history",
    duration_min: 12,
    when: "After easy runs or on rest days, 2x per week. Eases hip tightness that often goes with lateral knee or hip pain.",
    exercises: [
      { name: "Kneeling hip flexor stretch", dose: "2 x 40 s per side", cue: "Tuck the pelvis under, squeeze the glute of the back leg." },
      { name: "Figure-4 stretch (supine)", dose: "2 x 40 s per side", cue: "Keep the head down and the lower back flat." },
      { name: "Glute bridge", dose: "2 x 12", cue: "Push through the heels, ribs down, pause 1 s at the top." },
      { name: "Clamshell", dose: "2 x 15 per side", cue: "Feet together, pelvis stays still, no rolling back." },
      { name: "Side-lying leg raise", dose: "2 x 12 per side", cue: "Toes forward, lift to about 30 degrees, slow lowering." },
    ],
  },
  {
    id: "itb-strength",
    name: "Hip and glute strength for runners",
    duration_min: 20,
    when: "2x per week on an easy or rest day, not before a hard session. Skip an exercise that causes sharp pain.",
    exercises: [
      { name: "Single-leg glute bridge", dose: "3 x 10 per side", cue: "Hips level, no arching of the lower back." },
      { name: "Lateral band walk", dose: "3 x 12 steps each way", cue: "Band above the knees, small steps, knees over toes." },
      { name: "Side plank", dose: "3 x 25-40 s per side", cue: "Straight line from head to feet, hips high." },
      { name: "Single-leg Romanian deadlift", dose: "3 x 8 per side", cue: "Hinge at the hip, soft standing knee, hips square." },
      { name: "Step-down", dose: "3 x 8 per side", cue: "Slow 3 s lowering, knee tracks over the second toe." },
    ],
  },
  {
    id: "pre-run-dynamic",
    name: "Pre-run dynamic warm-up",
    duration_min: 6,
    when: "Before any run, longer before quality sessions.",
    exercises: [
      { name: "Leg swings (front/back and side)", dose: "10 per direction per leg", cue: "Tall posture, swing from the hip, hold a wall if needed." },
      { name: "Walking lunges", dose: "2 x 8 per side", cue: "Upright torso, back knee hovers above the ground." },
      { name: "A-skips", dose: "2 x 20 m", cue: "Quick light contacts, knee up, opposite arm." },
      { name: "High knees", dose: "2 x 20 m", cue: "Fast cadence, stay on the balls of the feet." },
    ],
  },
  {
    id: "post-run",
    name: "Post-run stretch",
    duration_min: 6,
    when: "After a run when time allows. Optional; no strong evidence it prevents injury, but many runners find it helps.",
    exercises: [
      { name: "Calf stretch (straight and bent knee)", dose: "30 s each, per side", cue: "Heel down, lean in gently." },
      { name: "Hamstring stretch", dose: "30 s per side", cue: "Long spine, hinge forward, no bouncing." },
      { name: "Quad stretch", dose: "30 s per side", cue: "Knees together, tuck the pelvis under." },
      { name: "Hip flexor stretch", dose: "30 s per side", cue: "Squeeze the glute of the back leg." },
    ],
  },
  {
    id: "runner-core",
    name: "Runner core",
    duration_min: 10,
    when: "2x per week, any day without a hard session the next morning.",
    exercises: [
      { name: "Dead bug", dose: "3 x 8 per side", cue: "Lower back stays on the floor, exhale as the limbs extend." },
      { name: "Bird dog", dose: "3 x 8 per side", cue: "Hips level, reach long rather than high." },
      { name: "Front plank", dose: "3 x 30-45 s", cue: "Ribs down, squeeze the glutes." },
      { name: "Side plank", dose: "2 x 25-40 s per side", cue: "Straight line from head to feet." },
    ],
  },
  {
    id: "foam-roll",
    name: "Foam rolling",
    duration_min: 8,
    when: "After runs or on rest days. Roll the muscles around the IT band (quads, glutes, TFL), not the band itself.",
    exercises: [
      { name: "Quads", dose: "60 s per side", cue: "Slow passes, pause on tender spots for 10 s." },
      { name: "Glutes", dose: "60 s per side", cue: "Cross one ankle over the opposite knee to reach deeper." },
      { name: "TFL (front of hip, just outside the hip bone)", dose: "45 s per side", cue: "Small movements, ease off if sharp." },
      { name: "Calves", dose: "60 s per side", cue: "Cross the legs to add pressure." },
    ],
  },
];

export const routineById = (id: string) => ROUTINES.find((r) => r.id === id);
