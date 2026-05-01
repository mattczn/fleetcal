export interface LearningStep {
  id: string;
  label: string;
  hint?: string;
}

export interface LearningModule {
  id: string;
  title: string;
  steps: LearningStep[];
}

export const LEARNING_MODULES: LearningModule[] = [
  {
    id: 'scheduling',
    title: 'Scheduling Loads',
    steps: [
      { id: 'create-slot',     label: 'Create a load',              hint: 'Click any empty time slot on the calendar' },
      { id: 'drag-reschedule', label: 'Drag a load to reschedule',  hint: 'Drag any load block to a new time or column' },
      { id: 'update-status',   label: 'Update a load status',       hint: 'Open a load and change status to En Route, Delivered, etc.' },
      { id: 'mini-calendar',   label: 'Jump dates with mini calendar', hint: 'Click any date in the sidebar calendar to navigate' },
    ],
  },
  {
    id: 'ai-tools',
    title: 'AI Rate Con Parser',
    steps: [
      { id: 'single-ratecon', label: 'Parse a single rate con',    hint: 'Open any load → drop a PDF → AI fills in the details' },
      { id: 'batch-ratecon',  label: 'Batch import multiple PDFs', hint: 'Click the stack icon next to New Load to upload up to 10 PDFs at once' },
    ],
  },
  {
    id: 'advanced',
    title: 'Advanced Load Features',
    steps: [
      { id: 'relay-load',     label: 'Set up a split / relay load', hint: 'Open a load → scroll to Relay → assign a pickup and delivery driver' },
      { id: 'accessorial',    label: 'Add an accessorial charge',   hint: 'Open a load → scroll to Accessorials → add detention, lumper, etc.' },
      { id: 'duplicate',      label: 'Duplicate a load',            hint: 'Open a load → click Duplicate in the footer' },
      { id: 'plus-one-week',  label: 'Schedule a load +1 week',     hint: 'Open a load → click +1 Week to copy it to the same day next week' },
    ],
  },
  {
    id: 'history',
    title: 'Load History',
    steps: [
      { id: 'search-load',      label: 'Search for a load',           hint: 'Use the search bar in the toolbar — search by title, load #, or driver' },
      { id: 'recently-deleted', label: 'View recently deleted loads',  hint: 'Click the trash icon in the toolbar' },
      { id: 'restore-load',     label: 'Restore a deleted load',       hint: 'Click the restore arrow next to any deleted load' },
    ],
  },
];

export const ALL_STEP_IDS = LEARNING_MODULES.flatMap(m => m.steps.map(s => s.id));
