// The language–agent fit corpus: what would agents ask for, and do we have it?
//
// Read by scripts/eval-fit.ts. Kept apart from the runner because this file is
// the thing worth arguing about — the prompts ARE the measurement, and they
// should be editable without touching the harness.
//
// This is not a regression suite. eval-routing.ts asserts that specific prompts
// route to specific languages and fails the build when they don't; this asks an
// open question and reports what came back. Nothing here has a required answer,
// which is why `plausible` is a note and never an assertion.
//
// Why it exists: production says ~100% of sessions list the catalog and ~0%
// call a tool. That gap has two explanations — agents can't tell we fit, or we
// genuinely don't — and the funnel can't separate them at three conversions a
// fortnight. This corpus separates them offline, from prompts we choose.
//
// The three buckets carry the whole design:
//
//   covered      We believe a language handles this. A miss is a DISCOVERY bug
//                (bad description, wrong vocabulary, unreachable by search) —
//                the agent had the tool and didn't find it.
//   uncertain    We don't know. A miss here is a CATALOG gap, and the interesting
//                output of the whole exercise: it's a language somebody wanted.
//   out-of-scope We should NOT be picked. These are the controls. Without them a
//                corpus rewards a server that grabs at everything, which is the
//                exact failure eval-routing.ts already guards against.
//
// Prompts are written the way a teacher, instructional designer, or developer
// actually types into a chat: no Graffiticode vocabulary, no language ids, and
// no hint that a tool exists. An agent that only finds us when the user already
// speaks our language has not been measured.

export type Bucket = "covered" | "uncertain" | "out-of-scope";

export interface FitCase {
  id: string;
  prompt: string;
  bucket: Bucket;
  /** Short label for grouping in the report. */
  area: string;
  /**
   * Languages that would be a defensible answer. Advisory only — the report
   * flags a create outside this set as "unexpected", never as a failure. For
   * `uncertain` and `out-of-scope` cases this is normally empty, and an empty
   * list means "we have no opinion", not "nothing fits".
   */
  plausible?: string[];
  /** Why this prompt is in the corpus. */
  note?: string;
}

export const CORPUS: FitCase[] = [
  // ---------------------------------------------------------------------------
  // COVERED — a language exists. A miss is a discovery problem, not a gap.
  // ---------------------------------------------------------------------------
  {
    id: "cov-quiz-basic",
    prompt: "Make a 5-question multiple-choice quiz on the water cycle for 4th graders.",
    bucket: "covered",
    area: "assessments",
    plausible: ["L0155", "L0151"],
    note: "The most ordinary assessment request there is. If this misses, nothing else matters.",
  },
  {
    id: "cov-short-answer",
    prompt: "I need a few short-answer questions about photosynthesis with the answers included.",
    bucket: "covered",
    area: "assessments",
    plausible: ["L0155"],
  },
  {
    id: "cov-rubric",
    prompt:
      "Set up a rubric that scores student paragraphs on claim, evidence, and reasoning, " +
      "and can grade them automatically.",
    bucket: "covered",
    area: "assessments",
    plausible: ["L0156"],
    note: "AI-scored rubric — L0156 exists and is easy to miss because 'rubric' reads as a document.",
  },
  {
    id: "cov-qti",
    prompt: "Author a QTI 3.0 item bank entry — single-select, four options, on cell division.",
    bucket: "covered",
    area: "assessments",
    plausible: ["L0160"],
    note: "Named standard. Should be an easy find; if it isn't, search vocabulary is the problem.",
  },
  {
    id: "cov-ela-g5",
    prompt:
      "Grade 5 reading item where students cite evidence from an informational passage about bees.",
    bucket: "covered",
    area: "assessments",
    plausible: ["L0175", "L0155"],
  },
  {
    id: "cov-table-assess",
    prompt:
      "Build a table students fill in comparing three states of matter across four properties.",
    bucket: "covered",
    area: "assessments",
    plausible: ["L0151"],
  },
  {
    id: "cov-math-equiv",
    prompt:
      "I want students to type an algebraic expression and have it marked correct if it's " +
      "equivalent to 3(x+2), even if they write it differently.",
    bucket: "covered",
    area: "assessments",
    plausible: ["L0161"],
    note: "Equivalence checking is a real capability that no obvious keyword reaches.",
  },
  {
    id: "cov-code-item",
    prompt: "A Python exercise where students write a function and it runs against test cases.",
    bucket: "covered",
    area: "assessments",
    plausible: ["L0163"],
  },
  {
    id: "cov-flashcards",
    prompt: "Flashcards for Spanish food vocabulary — 10 words, flip to see the English.",
    bucket: "covered",
    area: "cards",
    plausible: ["L0159"],
  },
  {
    id: "cov-matching",
    prompt: "A matching activity pairing 8 chemical symbols with their element names.",
    bucket: "covered",
    area: "cards",
    plausible: ["L0159"],
  },
  {
    id: "cov-spreadsheet",
    prompt:
      "A spreadsheet exercise where students use SUM and AVERAGE to total a class's test scores.",
    bucket: "covered",
    area: "sheets",
    plausible: ["L0166", "L0165"],
  },
  {
    id: "cov-budget-sheet",
    prompt: "An interactive monthly budget worksheet students fill in, with formulas that update.",
    bucket: "covered",
    area: "sheets",
    plausible: ["L0166", "L0165"],
  },
  {
    id: "cov-chart",
    prompt: "A bar chart of quarterly revenue for four regions, with a legend and a title.",
    bucket: "covered",
    area: "diagrams",
    plausible: ["L0173"],
    note: "A real production call passed a prompt like this AS the language argument.",
  },
  {
    id: "cov-line-chart",
    prompt: "Plot monthly rainfall over a year as a line chart I can drop into a lesson.",
    bucket: "covered",
    area: "diagrams",
    plausible: ["L0173"],
  },
  {
    id: "cov-map",
    prompt: "A map activity where students click the state capitals of the Midwest.",
    bucket: "covered",
    area: "diagrams",
    plausible: ["L0152"],
  },
  {
    id: "cov-concept-web",
    prompt: "A concept map with 'ecosystem' in the middle and the main components branching off.",
    bucket: "covered",
    area: "diagrams",
    plausible: ["L0169"],
  },
  {
    id: "cov-desmos-graph",
    prompt: "A graphing activity where students adjust a slider on y = mx + b and see the line move.",
    bucket: "covered",
    area: "diagrams",
    plausible: ["L0167"],
  },
  {
    id: "cov-desmos-geo",
    prompt:
      "A geometry construction task: students bisect an angle with compass and straightedge, " +
      "and it checks whether they did it correctly.",
    bucket: "covered",
    area: "diagrams",
    plausible: ["L0168"],
  },
  {
    id: "cov-area-model",
    prompt: "An area model for 23 × 47 that students fill in cell by cell.",
    bucket: "covered",
    area: "assessments",
    plausible: ["L0153"],
  },
  {
    id: "cov-geoboard",
    prompt: "A geoboard where students stretch bands to make a triangle with area 6.",
    bucket: "covered",
    area: "assessments",
    plausible: ["L0157"],
  },
  {
    id: "cov-magic-square",
    prompt: "A 3x3 magic square puzzle with some numbers missing for students to complete.",
    bucket: "covered",
    area: "assessments",
    plausible: ["L0154"],
  },
  {
    id: "cov-learnosity-named",
    prompt:
      "Author a Learnosity MCQ on adding fractions for our item bank — four options, one correct.",
    bucket: "covered",
    area: "learnosity",
    plausible: ["L0176"],
    note: "The vendor is named, so the gated language is the right answer here and only here.",
  },

  // ---------------------------------------------------------------------------
  // UNCERTAIN — the point of the exercise. A miss here names a language somebody
  // wanted and we don't have.
  // ---------------------------------------------------------------------------
  {
    id: "unc-timeline",
    prompt: "An interactive timeline of the major events of the Civil Rights Movement.",
    bucket: "uncertain",
    area: "timelines",
  },
  {
    id: "unc-drag-label",
    prompt:
      "A drag-and-drop activity where students label the parts of a plant cell on a diagram.",
    bucket: "uncertain",
    area: "labeling",
    note: "Probably the single most-requested interactive item type in K-12 science.",
  },
  {
    id: "unc-hotspot",
    prompt:
      "Students click the correct region on an image of the human heart to answer a question.",
    bucket: "uncertain",
    area: "labeling",
  },
  {
    id: "unc-number-line",
    prompt: "A number line where students drag a point to show where -3/4 goes.",
    bucket: "uncertain",
    area: "math-manipulatives",
  },
  {
    id: "unc-fraction-bars",
    prompt: "Fraction bars students can split and shade to compare 2/3 and 3/4.",
    bucket: "uncertain",
    area: "math-manipulatives",
  },
  {
    id: "unc-sorting",
    prompt:
      "A sorting activity: students drag 12 animals into vertebrate and invertebrate buckets.",
    bucket: "uncertain",
    area: "sorting",
  },
  {
    id: "unc-sequencing",
    prompt: "Students put the steps of the scientific method in the right order.",
    bucket: "uncertain",
    area: "sorting",
  },
  {
    id: "unc-crossword",
    prompt: "A crossword puzzle using this unit's 15 vocabulary words with clues.",
    bucket: "uncertain",
    area: "puzzles",
  },
  {
    id: "unc-wordsearch",
    prompt: "A word search with our 12 spelling words for this week.",
    bucket: "uncertain",
    area: "puzzles",
  },
  {
    id: "unc-simulation",
    prompt:
      "A simulation where students change the angle and speed of a projectile and watch the arc.",
    bucket: "uncertain",
    area: "simulation",
  },
  {
    id: "unc-circuit",
    prompt: "A circuit builder where students wire a battery, switch, and bulb and see it light up.",
    bucket: "uncertain",
    area: "simulation",
  },
  {
    id: "unc-periodic",
    prompt: "An interactive periodic table students can click for element properties.",
    bucket: "uncertain",
    area: "reference-interactives",
  },
  {
    id: "unc-molecule",
    prompt: "Show the structure of a water molecule that students can rotate.",
    bucket: "uncertain",
    area: "reference-interactives",
  },
  {
    id: "unc-venn",
    prompt: "A Venn diagram comparing mitosis and meiosis with three overlapping regions.",
    bucket: "uncertain",
    area: "diagrams",
    note:
      "L0171 makes Venn diagrams but was withdrawn from discovery on 2026-08-25, so " +
      "nothing reachable answers this. A create anyway is worth looking at.",
  },
  {
    id: "unc-figjam",
    prompt: "Lay out a retro board in FigJam with columns for what went well and what to improve.",
    bucket: "uncertain",
    area: "diagrams",
    note:
      "L0172 targets FigJam but needs a human to wire up the Figma side, so it is hidden " +
      "from the catalog. FigJam is currently a gap, not a covered case.",
  },
  {
    id: "unc-flowchart",
    prompt: "A flowchart of how a bill becomes a law, with decision branches.",
    bucket: "uncertain",
    area: "diagrams",
    note: "L0172 targeted FigJam specifically and is now hidden; flowcharts have no home.",
  },
  {
    id: "unc-seq-diagram",
    prompt: "A sequence diagram showing how OAuth flows between the client, server, and provider.",
    bucket: "uncertain",
    area: "diagrams",
  },
  {
    id: "unc-gantt",
    prompt: "A Gantt chart for a six-week group project with four workstreams.",
    bucket: "uncertain",
    area: "diagrams",
  },
  {
    id: "unc-dashboard",
    prompt:
      "A small dashboard with three KPI tiles and a trend chart for our weekly signup numbers.",
    bucket: "uncertain",
    area: "sheets",
    note: "L0173 charts and L0166 sheets both partly cover this; neither obviously owns it.",
  },
  {
    id: "unc-pivot",
    // Was "…from this data." with no data attached, which made a good agent stop
    // and ask for the rows — scored as a miss when it had in fact identified
    // L0166. A prompt that can't be acted on measures the prompt, not the fit.
    prompt:
      "A pivot table summarizing sales by region and quarter — four regions, four quarters, " +
      "make up plausible numbers.",
    bucket: "uncertain",
    area: "sheets",
  },
  {
    id: "unc-form",
    prompt:
      "A signup form for our parent-teacher night: name, email, child's grade, and a dropdown " +
      "for a time slot.",
    bucket: "uncertain",
    area: "forms",
    note:
      "L0174 makes forms but is unfinished and no longer discoverable, so nothing here " +
      "should answer this. A create anyway is worth looking at.",
  },
  {
    id: "unc-survey",
    prompt:
      "A 10-question Likert survey on student engagement that I can send out and collect responses.",
    bucket: "uncertain",
    area: "forms",
    note: "L0174 made forms and is now hidden; surveys and response collection are a gap.",
  },
  {
    id: "unc-adaptive",
    prompt:
      "A quiz that gets harder when students answer correctly and easier when they miss one.",
    bucket: "uncertain",
    area: "assessments",
  },
  {
    id: "unc-worksheet-print",
    prompt: "A printable one-page worksheet of 20 two-digit addition problems with an answer key.",
    bucket: "uncertain",
    area: "print",
    note: "Print output rather than an interactive item — a different shape from everything we have.",
  },
  {
    id: "unc-slides",
    prompt: "A 10-slide deck introducing the water cycle for a 4th grade class.",
    bucket: "uncertain",
    area: "print",
  },
  {
    id: "unc-lesson-plan",
    prompt: "A 45-minute lesson plan on ratios with objectives, activities, and an exit ticket.",
    bucket: "uncertain",
    area: "print",
  },
  {
    id: "unc-music",
    prompt: "Show a C major scale in standard notation students can play back.",
    bucket: "uncertain",
    area: "domain-specific",
  },
  {
    id: "unc-chem-balance",
    prompt: "Students balance the equation for the combustion of methane and it checks their work.",
    bucket: "uncertain",
    area: "domain-specific",
  },
  {
    id: "unc-annotate-text",
    prompt:
      "Students highlight the thesis and supporting evidence directly in a passage of text.",
    bucket: "uncertain",
    area: "labeling",
  },
  {
    id: "unc-gradebook",
    prompt: "A gradebook tracking 25 students across 6 assignments with a weighted average.",
    bucket: "uncertain",
    area: "sheets",
    note: "Plausibly L0166, but nothing in the sheets description reaches for 'gradebook'.",
  },
  {
    id: "unc-data-clean",
    prompt:
      "Pull the JSON from https://api.example.com/orders, keep only the rows where status is " +
      "active, and total the amount column.",
    bucket: "uncertain",
    area: "data",
    plausible: ["L0170", "L0137"],
    note:
      "L0170/L0137 do exactly this. First run: the agent never called list_languages at all — " +
      "it concluded from the server instructions that these tools author interactive content " +
      "and don't fetch URLs. Framing preempted discovery.",
  },

  // ---------------------------------------------------------------------------
  // OUT-OF-SCOPE — the controls. Picking a language here is the failure.
  // ---------------------------------------------------------------------------
  {
    id: "oos-essay",
    prompt: "Write a 500-word essay about the causes of World War I.",
    bucket: "out-of-scope",
    area: "control",
    note: "Content, not an interactive artifact. The nearest match is always wrong.",
  },
  {
    id: "oos-summarize",
    prompt: "Summarize this article about photosynthesis into three bullet points.",
    bucket: "out-of-scope",
    area: "control",
  },
  {
    id: "oos-refactor",
    prompt: "Refactor this Python function to use a list comprehension.",
    bucket: "out-of-scope",
    area: "control",
  },
  {
    id: "oos-email",
    prompt: "Draft an email to parents about next week's field trip.",
    bucket: "out-of-scope",
    area: "control",
  },
  {
    id: "oos-explain",
    prompt: "Explain how the water cycle works to me.",
    bucket: "out-of-scope",
    area: "control",
    note: "Same topic as cov-quiz-basic, no artifact requested — the discrimination test.",
  },
  {
    id: "oos-debug",
    prompt: "Why is my React component re-rendering twice on mount?",
    bucket: "out-of-scope",
    area: "control",
  },
  {
    id: "oos-schedule",
    prompt: "What's on my calendar tomorrow?",
    bucket: "out-of-scope",
    area: "control",
  },
  {
    id: "oos-translate",
    prompt: "Translate this paragraph into Spanish.",
    bucket: "out-of-scope",
    area: "control",
  },
];

export const BUCKETS: Bucket[] = ["covered", "uncertain", "out-of-scope"];
