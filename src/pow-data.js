// The questions, PPE and hazards from the paper assessment, in one place so
// the app, the PDF and the stored record can't drift apart.

export const BEFORE_QUESTIONS = [
  ['q1', 'Are you at the correct plant / site?'],
  ['q2', 'Are you authorised and qualified to undertake the work?'],
  ['q3', 'Have you completed the task before, if not are you confident to complete the work?'],
  ['q4', 'Do you know how to get help or where to go in an emergency situation?'],
  ['q5', 'Are you working with generic risk assessments?'],
  ['q6', 'Do you have a Safe System of Work for the task?'],
  ['q7', 'Is the client aware of your work?'],
  ['q8', 'Does someone know where you are working?'],
  ['q9', 'Have work permits been issued?'],
  ['q10', 'Do you have the correct PPE for the job?'],
  ['q11', 'Are your tools in good condition and fit for use?'],
  ['q12', 'Are ladders, steps or scaffolds inspected?'],
  ['q13', "Have you completed a contractor's induction?"],
];

export const PPE_ITEMS = [
  ['boots', 'Work boots'], ['gloves', 'Gloves'], ['hardhat', 'Hard hat'],
  ['hivis', 'High visibility vest'], ['eyes', 'Eye protection'], ['ears', 'Hearing protection'],
  ['mask', 'Face mask'], ['harness', 'Harness'], ['seatbelt', 'Seatbelt'],
  ['extinguisher', 'Fire extinguisher'], ['weld', 'Weld helmet'], ['firstaid', 'First aid kit'],
  ['gas', 'Gas mask'],
];

export const HAZARDS = [
  ['h1', 'Falls from height'], ['h2', 'Fragile surfaces'], ['h3', 'Falling or flying objects'],
  ['h4', 'COSHH substances'], ['h5', 'Slips, trips or falls'], ['h6', 'Poor lighting'],
  ['h7', 'Adverse weather'], ['h8', 'Entry into confined space'], ['h9', 'Fumes'],
  ['h10', 'Noise'], ['h11', 'Vibration'], ['h12', 'Electricity'],
  ['h13', 'Material in vessels'], ['h14', 'Stored energy or insecure load'], ['h15', 'Manual handling'],
  ['h16', 'Temperature (high or low)'], ['h17', 'Lone working'], ['h18', 'Traffic or moving vehicles'],
  ['h19', 'Other contractors'], ['h20', 'Heat, fire or explosion'],
];

export const REVIEW_QUESTIONS = [
  ['improvements', 'Are there any improvements that could be made?'],
  ['newHazards', 'Has the work created any new hazards?'],
  ['amendRa', 'Does the generic risk assessment need amending?'],
];

export const RISK_LEVELS = ['Low', 'Medium', 'High'];

export const DEFAULT_RA_LIBRARY = [
  'RA - 1001 - Promtek Control Server Configuration',
  'RA - 1009 - On-Site Commissioning',
  'RA - 1011 - Fire Safety Risk Assessment',
  'RA - 1012 - COVID-19 Coronavirus Site Work',
  'RA - 1014 - Display Screen Equipment',
  'RA - 1015 - Working in Extreme Weather',
  'RA - 1017 - Disabled Staff and Visitors',
  'RA - 1019 - Young Persons',
  'RA - 1020 - Slips Trips and Falls Risk Assessment',
  'SSOW - 1001 - Promtek Control Server Configuration',
  'SSOW - 1008 - On Site Calibration',
  'SSOW - 1009 - On Site Commissioning',
  'SSOW - 1010 - On Site Service',
  'SSOW - 1018 - On Site Breakdown',
];

export const SITE_VISIT_TYPES = [
  'Service Visit', 'Calibration Visit', 'New Order Site Visit',
  'Service Contract Site Visit', 'Commissioning Site Visit',
];

// Which status each visit type moves to once someone is on site.
export const ON_SITE_STATUS = {
  'New Order Site Visit': 'Commissioning',
  'Commissioning Site Visit': 'Commissioning',
  'Service Visit': 'Visit In-Progress',
  'Calibration Visit': 'Visit In-Progress',
  'Service Contract Site Visit': 'Visit In-Progress',
};

export const labelOf = (list, id) => (list.find(([key]) => key === id) || [null, id])[1];
