// The documents a job can need, and what each one asks for. Every document is put together
// from the same kinds of field, filled in on the job as the work is done, then laid out by
// the hub as a Promtek document (and, for the long lists, a spreadsheet as well).
//
// Field kinds:
//   text, number, date, select (options), textarea: a single answer
//   table: rows of columns, added to as needed or pasted from Excel; group: the column the
//          document groups rows under; rows: rows it starts with
//   tests: numbered checks, each with Pass, Fail or Not applicable, date, initials and a note
//   checklist: items ticked Yes, No or Not applicable, each with a note
//   steps: a numbered list
//   photos: pictures with captions; files: anything else, put straight onto the job in Jira
//   signoff: each person named signs (drawn on screen), with name, position and date
//   chapters: a repeating set of the fields inside it, one per area of the plant or system
//   docs: the documents finished on the order so far, listed for handover
//   note: text printed as it is, for guidance in the document itself

// The disciplines, as the hub names them, and as the categories in Jira do.
export const DISCIPLINE_NAMES = { software: 'Software', hardware: 'Hardware', engineering: 'Site visit', condor: 'Condor' };

const PASS = ['Pass', 'Fail', 'Not applicable'];
const YES = ['Yes', 'No', 'Not applicable'];

const IO_COLUMNS = [
  { id: 'no', label: 'I/O No', w: 5, aka: ['i/o number', 'io no', 'i/o no'] },
  { id: 'tag', label: 'Tag', w: 9, aka: ['site ref', 'site ref.', 'tag no'] },
  { id: 'description', label: 'Description', w: 20 },
  { id: 'symbol', label: 'PLC symbol', w: 16, aka: ['abbreviation', 'symbol'] },
  { id: 'type', label: 'Type', w: 5, type: 'select', options: ['DI', 'DO', 'AI', 'AO'] },
  { id: 'plc', label: 'PLC', w: 4, aka: ['plc number', 'plc no'] },
  { id: 'rack', label: 'Rack', w: 5, aka: ['plc rack'] },
  { id: 'slot', label: 'Slot', w: 4, aka: ['plc slot'] },
  { id: 'channel', label: 'Ch', w: 4, aka: ['channel'] },
  { id: 'address', label: 'Address', w: 7, aka: ['plc reference', 'plc ref'] },
  { id: 'range', label: 'Range / units', w: 8, aka: ['range'] },
  { id: 'signal', label: 'Signal', w: 6, aka: ['control voltage'] },
  { id: 'terminal', label: 'Terminal', w: 6 },
  { id: 'notes', label: 'Notes', w: 10 },
];

const TIMER_COLUMNS = [
  { id: 'no', label: 'Timer No', w: 8 }, { id: 'description', label: 'Description', w: 40 },
  { id: 'tag', label: 'Tag', w: 28 }, { id: 'default', label: 'Default', w: 12 },
];
const ALARM_COLUMNS = [
  { id: 'alarm', label: 'Alarm', w: 25 }, { id: 'meaning', label: 'What it means', w: 45 }, { id: 'action', label: 'What to do', w: 30 },
];

const CHAPTER = [
  { id: 'overview', type: 'textarea', label: 'Overview', help: 'What this part of the plant or system does.' },
  { id: 'sequence', type: 'steps', label: 'Operation sequence', help: 'What happens, in order.' },
  { id: 'timers', type: 'table', label: 'Timers', columns: [{ id: 'timer', label: 'Timer', w: 30 }, { id: 'purpose', label: 'What it does', w: 50 }, { id: 'default', label: 'Default', w: 20 }] },
  { id: 'alarms', type: 'table', label: 'Alarms', columns: ALARM_COLUMNS },
  { id: 'graphics', type: 'photos', label: 'Screens', help: 'Screen captures, each with a caption saying what it shows.' },
  { id: 'notes', type: 'textarea', label: 'Notes' },
];

const TEST_COLUMNS_FAT = [
  { id: 'test', label: 'Test', w: 34 }, { id: 'expected', label: 'Expected result', w: 30 },
];

// The starting list. Admins and Management can change the names, who it's for, which
// categories have each ticked to start with, the XP rate, and add their own.
export const LIBRARY = [
  // ---------- design ----------
  {
    id: 'req-spec', name: 'Requirements Specification', group: 'Design', audience: 'customer', disciplines: ['software'],
    title: 'Requirements Specification Document',
    intro: 'The following document specifies the requirements for the software and hardware provided by Promtek.',
    header: ['customer_order'],
    sections: [
      { title: 'Date of project meeting', fields: [{ id: 'meeting_date', type: 'date', label: 'Date' }, { id: 'meeting', type: 'textarea', label: 'Who attended and what was agreed' }] },
      { title: 'Information from the customer', fields: [
        { id: 'spec', type: 'textarea', label: 'Specification provided by the customer', blank: 'N/A' },
        { id: 'flow', type: 'textarea', label: 'Flow diagrams provided by the customer', blank: 'N/A' },
        { id: 'data', type: 'textarea', label: 'Data provided by the customer', blank: 'N/A' },
        { id: 'customer_files', type: 'files', label: 'Files from the customer' },
      ] },
      { title: 'Hardware', fields: [
        { id: 'hardware', type: 'table', label: 'Hardware', columns: [{ id: 'part', label: 'Part No', w: 20 }, { id: 'description', label: 'Description', w: 65 }, { id: 'qty', label: 'Qty', w: 15 }] },
        { id: 'hardware_diagram', type: 'photos', label: 'Hardware diagram', blank: 'N/A' },
      ] },
      { title: 'Input/Output allocation', fields: [
        { id: 'io', type: 'table', label: 'I/O', columns: IO_COLUMNS.filter((c) => !['symbol', 'notes'].includes(c.id)), group: 'type', groupNames: { DI: 'Digital Inputs', DO: 'Digital Outputs', AI: 'Analogue Inputs', AO: 'Analogue Outputs' } },
        { id: 'comms', type: 'table', label: 'Comms', columns: [{ id: 'port', label: 'Port', w: 7 }, { id: 'description', label: 'Description', w: 25 }, { id: 'protocol', label: 'Protocol', w: 12 }, { id: 'baud', label: 'Baud', w: 9 }, { id: 'settings', label: 'Data/Stop/Parity', w: 13 }, { id: 'port_ip', label: 'Port IP', w: 17 }, { id: 'device_ip', label: 'Device IP', w: 17 }] },
        { id: 'timers', type: 'table', label: 'Timers', columns: TIMER_COLUMNS },
        { id: 'alarms', type: 'table', label: 'Alarms', columns: [{ id: 'no', label: 'Alarm No', w: 10 }, { id: 'description', label: 'Description', w: 50 }, { id: 'tag', label: 'Tag', w: 40 }] },
      ] },
      { title: 'Screen changes', fields: [{ id: 'screens', type: 'textarea', label: 'Screen changes' }, { id: 'screen_shots', type: 'photos', label: 'Graphics' }] },
      { title: 'Software description', fields: [{ id: 'software', type: 'textarea', label: 'What the software will do', rows: 8 }] },
      { title: 'Contingency planning', fields: [{ id: 'contingency', type: 'textarea', label: 'Contingency planning',
        start: 'All current software and database will be backed up before software installation in case it is necessary to roll the new version back. If the new software does not operate correctly we will put the old software back until the problem is resolved.' }] },
      { title: 'Electrical installation', fields: [{ id: 'electrical', type: 'textarea', label: 'Who installs it, and what is needed' }] },
      { title: 'Calibration procedure', fields: [{ id: 'calibration', type: 'textarea', label: 'Calibration procedure', blank: 'N/A' }] },
      { title: 'Required delivery dates', fields: [{ id: 'dates', type: 'table', label: 'Dates', columns: [{ id: 'what', label: 'What', w: 70 }, { id: 'date', label: 'Date', w: 30, type: 'date' }] }] },
    ],
  },
  {
    id: 'io-list', name: 'I/O List', group: 'Design', audience: 'customer', disciplines: ['software'], landscape: true, spreadsheet: true,
    title: 'Input/Output List', intro: 'Every input and output on the control system, by PLC and signal type.',
    header: ['customer_order'],
    sections: [
      { title: 'PLCs and remote I/O', fields: [{ id: 'plcs', type: 'table', label: 'PLCs', columns: [
        { id: 'plc', label: 'PLC No', w: 8 }, { id: 'type', label: 'Make and model', w: 18 }, { id: 'description', label: 'Description', w: 22 },
        { id: 'location', label: 'Location', w: 16 }, { id: 'ip', label: 'IP address', w: 14 }, { id: 'cards', label: 'Cards, by slot', w: 22 }] }] },
      { title: 'Inputs and outputs', fields: [
        { id: 'note', type: 'note', pdf: false, text: 'Paste the list straight from Excel, with its headings, or with the columns in the order shown. List spare channels with SPARE as the description, so the spare capacity on each card shows.' },
        { id: 'io', type: 'table', label: 'Inputs and outputs', columns: IO_COLUMNS, group: 'type', groupNames: { DI: 'Digital Inputs', DO: 'Digital Outputs', AI: 'Analogue Inputs', AO: 'Analogue Outputs' }, sub: 'plc', subLabel: 'PLC' },
      ] },
      { title: 'Comms', fields: [{ id: 'comms', type: 'table', label: 'Comms', columns: [
        { id: 'port', label: 'Port', w: 6 }, { id: 'device', label: 'Device', w: 18 }, { id: 'protocol', label: 'Protocol', w: 12 }, { id: 'baud', label: 'Baud', w: 8 },
        { id: 'settings', label: 'Data/Stop/Parity', w: 10 }, { id: 'port_ip', label: 'Port IP', w: 14 }, { id: 'device_ip', label: 'Device IP', w: 14 }, { id: 'notes', label: 'Notes', w: 18 }] }] },
      { title: 'Interlocks', fields: [{ id: 'interlocks', type: 'table', label: 'Interlocks', columns: [
        { id: 'device', label: 'Device', w: 15 }, { id: 'interlock', label: 'Interlocked with', w: 30 }, { id: 'condition', label: 'Condition', w: 35 }, { id: 'notes', label: 'Notes', w: 20 }] }] },
    ],
  },
  {
    id: 'alarm-list', name: 'Alarm List', group: 'Design', audience: 'customer', disciplines: [], landscape: true, spreadsheet: true,
    title: 'Alarm List', intro: 'Every alarm the system raises, what causes it and what the operator should do.',
    header: ['customer_order'],
    sections: [{ title: 'Alarms', fields: [{ id: 'alarms', type: 'table', label: 'Alarms', group: 'area', columns: [
      { id: 'no', label: 'No', w: 5 }, { id: 'area', label: 'Area', w: 12 }, { id: 'tag', label: 'Tag', w: 14 }, { id: 'description', label: 'Alarm', w: 20 },
      { id: 'priority', label: 'Priority', w: 8, type: 'select', options: ['High', 'Medium', 'Low'] }, { id: 'cause', label: 'Cause', w: 18 },
      { id: 'action', label: 'Operator action', w: 18 }, { id: 'reset', label: 'Reset', w: 8, type: 'select', options: ['Auto', 'Manual'] }] }] }],
  },
  {
    id: 'recipe-params', name: 'Recipe and Control Parameters', group: 'Design', audience: 'customer', disciplines: [], landscape: true, spreadsheet: true,
    title: 'Recipe and Control Parameters', intro: 'The recipe control codes and parameters, what each does and where it applies.',
    header: ['customer_order'],
    sections: [{ title: 'Parameters', fields: [{ id: 'params', type: 'table', label: 'Parameters', group: 'group', columns: [
      { id: 'code', label: 'Code', w: 10 }, { id: 'units', label: 'Units', w: 8 }, { id: 'description', label: 'Description', w: 30 }, { id: 'applies', label: 'Applies to', w: 14 },
      { id: 'group', label: 'Group', w: 14 }, { id: 'default', label: 'Default', w: 8 }, { id: 'commissioned', label: 'Commissioned', w: 8, type: 'select', options: ['Yes', 'No'] }, { id: 'notes', label: 'Notes', w: 8 }] }] }],
  },
  {
    id: 'network', name: 'Network and IP Schedule', group: 'Design', audience: 'customer', disciplines: ['condor'], landscape: true, spreadsheet: true,
    title: 'Network and IP Schedule', intro: 'The devices on the control network and how they are addressed.',
    header: ['customer_order'],
    sections: [{ title: 'Devices', fields: [{ id: 'devices', type: 'table', label: 'Devices', group: 'network', columns: [
      { id: 'network', label: 'Network', w: 12 }, { id: 'device', label: 'Device', w: 16 }, { id: 'description', label: 'Description', w: 22 }, { id: 'ip', label: 'IP address', w: 12 },
      { id: 'subnet', label: 'Subnet', w: 11 }, { id: 'gateway', label: 'Gateway', w: 11 }, { id: 'vlan', label: 'VLAN', w: 5 }, { id: 'location', label: 'Location', w: 11 }] }] },
      { title: 'Remote access', fields: [{ id: 'remote', type: 'textarea', label: 'How Promtek connects to the site, and who to ask', blank: 'N/A' }] }],
  },

  // ---------- software ----------
  {
    id: 'sw-test', name: 'Software Test Specification', group: 'Software', audience: 'internal', disciplines: ['software'],
    title: 'Internal Software Test Specification', intro: 'The following document specifies the software tests performed by Promtek.',
    header: ['customer_order', 'software_version', 'site'],
    sections: [
      { title: 'Test procedures', fields: [{ id: 'tests', type: 'tests', label: 'Tests', rows: [
        'IO testing from graphics: force device from graphics, check correct output set and alarm removed if correct input set',
        'Graphics device hotspots',
        'Check device interlocks',
        'Feeders: run batches containing materials for all feeders, check relevant feeder called',
        'Weigher combinations: run batches with recipes containing all weigher combinations and ingredient permutations for complex weighmix type jobs',
        'Run all transfers and fill up the batching system and cover any levels, then reset the sequences and test that all transfers and batching can be run after continuing all level alarms. Also check each individual section reset works similarly',
        'Routing to all bins: intake, bottom hopper, press, bin/silo transfers etc.',
        'PLC link: inputs, outputs, AIs, AOs, liquids, fast feeder cut-offs, link failure (check outputs removed)',
        'Livelink: batch reports, logs, period reports, database mirroring',
        'Any other serial links: platform scales etc.',
        'Specific tests relevant to the Requirements Specification',
        'Verify the current version operation matches the previous version, except for intentional changes, using side by side test Windows',
      ] }, { id: 'note', type: 'note', text: 'Only the tests performed should be dated and initialled. Any tests that are not relevant should be left blank.' }] },
      { title: 'Comments', fields: [{ id: 'comments', type: 'textarea', label: 'Comments' }] },
      { title: 'Sign-off', fields: [{ id: 'signoff', type: 'signoff', label: 'Signed', who: ['Tested by'] }] },
    ],
  },
  {
    id: 'sw-backup', name: 'Software Backup Record', group: 'Software', audience: 'internal', disciplines: ['software', 'condor'],
    title: 'Software Backup Record', intro: 'The software and firmware left on site, and where the backups are kept.',
    header: ['customer_order', 'site'],
    sections: [
      { title: 'Software installed', fields: [{ id: 'software', type: 'table', label: 'Software', columns: [
        { id: 'device', label: 'Device', w: 18 }, { id: 'software', label: 'Software or firmware', w: 22 }, { id: 'version', label: 'Version', w: 12 },
        { id: 'file', label: 'Backup file', w: 22 }, { id: 'location', label: 'Kept in', w: 16 }, { id: 'date', label: 'Date', w: 10, type: 'date' }] }] },
      { title: 'Backups', fields: [{ id: 'files', type: 'files', label: 'Backup files', help: 'These go onto the category in Jira, and from there into the job\'s Drive folder.' }] },
      { title: 'Licences and passwords held', fields: [{ id: 'licences', type: 'textarea', label: 'Licences, and where passwords are kept (never the passwords themselves)', blank: 'None' }] },
    ],
  },
  {
    id: 'operator-manual', name: 'Operator Manual', group: 'Software', audience: 'customer', disciplines: ['software'],
    title: 'Operator Manual', intro: 'How to operate the system, area by area.',
    header: ['customer_order'],
    sections: [
      { title: 'Introduction', fields: [{ id: 'intro', type: 'textarea', label: 'Introduction', rows: 5,
        start: "The control system's graphical interface gives a real-time overview of the process, including the plant devices in use, batch information for products in progress, timers throughout the process, and raw material and weigher information." }] },
      { title: 'Areas', fields: [{ id: 'areas', type: 'chapters', label: 'Area', fields: CHAPTER }] },
      { title: 'Common alarms', fields: [{ id: 'common_alarms', type: 'table', label: 'Common alarms', columns: ALARM_COLUMNS }] },
      { title: 'Device colours', fields: [{ id: 'colours', type: 'table', label: 'Device colours', columns: [{ id: 'colour', label: 'Colour', w: 25 }, { id: 'meaning', label: 'Meaning', w: 75 }] }] },
    ],
  },
  {
    id: 'change-record', name: 'Change Record', group: 'Software', audience: 'internal', disciplines: [],
    title: 'Change Record', intro: 'Changes made to a live system, why, and how they were tested.',
    header: ['customer_order', 'site'],
    sections: [
      { title: 'Changes', fields: [{ id: 'changes', type: 'table', label: 'Changes', columns: [
        { id: 'date', label: 'Date', w: 10, type: 'date' }, { id: 'change', label: 'Change', w: 30 }, { id: 'reason', label: 'Reason', w: 22 },
        { id: 'requested', label: 'Requested by', w: 13 }, { id: 'made', label: 'Made by', w: 12 }, { id: 'tested', label: 'Tested', w: 13 }] }] },
      { title: 'Going back', fields: [{ id: 'rollback', type: 'textarea', label: 'How the change can be undone' }] },
    ],
  },

  // ---------- hardware ----------
  {
    id: 'panel-check', name: 'Panel Build and Wiring Check', group: 'Hardware', audience: 'internal', disciplines: ['hardware'],
    title: 'Panel Build and Wiring Check', intro: 'The checks made on the panel before it leaves the workshop.',
    header: ['customer_order', 'panel'],
    sections: [
      { title: 'Build checks', fields: [{ id: 'checks', type: 'checklist', label: 'Checks', items: [
        'Panel built to the latest drawing revision', 'Component layout as drawn', 'Every termination tight and ferruled',
        'Wire numbers and markers fitted and correct', 'Component labels and legends fitted', 'Protective devices rated as drawn',
        'Glands, blanking plugs and IP rating as specified', 'Doors, locks and earth bonding of doors fitted', 'Panel clean, with swarf and offcuts removed',
      ] }] },
      { title: 'Electrical tests', fields: [{ id: 'tests', type: 'table', label: 'Tests', columns: [
        { id: 'test', label: 'Test', w: 34 }, { id: 'expected', label: 'Expected', w: 20 }, { id: 'measured', label: 'Measured', w: 20 },
        { id: 'result', label: 'Result', w: 12, type: 'select', options: PASS }, { id: 'initials', label: 'Initials', w: 14 }],
        rows: [{ test: 'Earth continuity' }, { test: 'Insulation resistance' }, { test: 'Supply voltage' }, { test: '24Vdc supply' }, { test: 'Polarity' }] }] },
      { title: 'Photos', fields: [{ id: 'photos', type: 'photos', label: 'Photos of the finished panel' }] },
      { title: 'Sign-off', fields: [{ id: 'signoff', type: 'signoff', label: 'Signed', who: ['Built by', 'Checked by'] }] },
    ],
  },
  {
    id: 'fat', name: 'Factory Acceptance Test', group: 'Hardware', audience: 'customer', disciplines: ['hardware'],
    title: 'Factory Acceptance Test', intro: 'The tests carried out at Promtek before delivery, and their results.',
    header: ['customer_order', 'test_date'],
    sections: [
      { title: 'Attendees', fields: [{ id: 'attendees', type: 'table', label: 'Attendees', columns: [{ id: 'name', label: 'Name', w: 35 }, { id: 'company', label: 'Company', w: 35 }, { id: 'role', label: 'Role', w: 30 }] }] },
      { title: 'Tests', fields: [{ id: 'tests', type: 'tests', label: 'Tests', columns: TEST_COLUMNS_FAT, witness: true }] },
      { title: 'Outstanding items', fields: [{ id: 'punch', type: 'table', label: 'Outstanding items', columns: [
        { id: 'item', label: 'Item', w: 45 }, { id: 'action', label: 'Action', w: 30 }, { id: 'owner', label: 'Who', w: 13 }, { id: 'due', label: 'By', w: 12, type: 'date' }] }] },
      { title: 'Sign-off', fields: [{ id: 'signoff', type: 'signoff', label: 'Signed', who: ['For Promtek', 'For the customer'] }] },
    ],
  },
  {
    id: 'drawings', name: 'Electrical Drawings (As Built)', group: 'Hardware', audience: 'customer', disciplines: ['hardware'],
    title: 'Electrical Drawings Register', intro: 'The as-built electrical drawings supplied with the system.',
    header: ['customer_order'],
    sections: [
      { title: 'Drawings', fields: [{ id: 'register', type: 'table', label: 'Drawings', columns: [
        { id: 'number', label: 'Drawing No', w: 18 }, { id: 'title', label: 'Title', w: 50 }, { id: 'rev', label: 'Rev', w: 10 }, { id: 'date', label: 'Date', w: 22, type: 'date' }] },
      { id: 'files', type: 'files', label: 'The drawings themselves', help: 'PDFs of the drawings. These go onto the category in Jira, and from there into the job\'s Drive folder.' }] },
    ],
  },
  {
    id: 'spares', name: 'Recommended Spares List', group: 'Hardware', audience: 'customer', disciplines: [], landscape: true, spreadsheet: true,
    title: 'Recommended Spares List', intro: 'The spares Promtek recommends keeping on site.',
    header: ['customer_order'],
    sections: [{ title: 'Spares', fields: [{ id: 'spares', type: 'table', label: 'Spares', columns: [
      { id: 'part', label: 'Part No', w: 14 }, { id: 'description', label: 'Description', w: 28 }, { id: 'make', label: 'Manufacturer', w: 14 },
      { id: 'fitted', label: 'Qty fitted', w: 8 }, { id: 'recommended', label: 'Qty to hold', w: 8 }, { id: 'lead', label: 'Lead time', w: 10 },
      { id: 'criticality', label: 'Criticality', w: 10, type: 'select', options: ['Critical', 'Important', 'Routine'] }, { id: 'notes', label: 'Notes', w: 8 }] }] }],
  },

  // ---------- site ----------
  {
    id: 'site-visit', name: 'Site Visit Report', group: 'Site', audience: 'customer', disciplines: ['engineering'],
    title: 'Site Visit Report', intro: 'The work Promtek carried out on site.',
    header: ['customer_order', 'site', 'visit_dates', 'site_contact'],
    sections: [
      { title: 'Reason for the visit', fields: [{ id: 'purpose', type: 'textarea', label: 'Why we went' }] },
      { title: 'Work carried out', fields: [{ id: 'work', type: 'steps', label: 'What was done' }, { id: 'photos', type: 'photos', label: 'Photos' }] },
      { title: 'Findings', fields: [{ id: 'findings', type: 'textarea', label: 'What was found', blank: 'Nothing further to report.' }] },
      { title: 'Parts used', fields: [{ id: 'parts', type: 'table', label: 'Parts', columns: [{ id: 'part', label: 'Part No', w: 20 }, { id: 'description', label: 'Description', w: 65 }, { id: 'qty', label: 'Qty', w: 15 }] }] },
      { title: 'Outstanding actions', fields: [{ id: 'actions', type: 'table', label: 'Actions', columns: [
        { id: 'action', label: 'Action', w: 55 }, { id: 'owner', label: 'Who', w: 25, type: 'select', options: ['Promtek', 'Customer', 'Third party'] }, { id: 'due', label: 'By', w: 20, type: 'date' }] }] },
      { title: 'Sign-off', fields: [{ id: 'signoff', type: 'signoff', label: 'Signed', who: ['Promtek engineer', 'For the customer'] }] },
    ],
  },
  {
    id: 'commissioning', name: 'Commissioning Report', group: 'Site', audience: 'customer', disciplines: ['engineering'],
    title: 'Commissioning Report', intro: 'How the system was commissioned on site, and the state it was left in.',
    header: ['customer_order', 'site', 'visit_dates'],
    sections: [
      { title: 'Systems commissioned', fields: [{ id: 'systems', type: 'table', label: 'Systems', columns: [
        { id: 'system', label: 'System or area', w: 35 }, { id: 'status', label: 'Status', w: 20, type: 'select', options: ['Commissioned', 'Partly commissioned', 'Not commissioned'] }, { id: 'notes', label: 'Notes', w: 45 }] }] },
      { title: 'Checks and tests', fields: [{ id: 'tests', type: 'tests', label: 'Tests', columns: TEST_COLUMNS_FAT, rows: [
        'I/O checked from field device to graphics', 'Interlocks proven', 'Alarms proven', 'Sequences run in automatic', 'Emergency stops proven', 'Reports and records checked',
      ] }] },
      { title: 'Software installed', fields: [{ id: 'versions', type: 'table', label: 'Versions', columns: [{ id: 'device', label: 'Device', w: 35 }, { id: 'software', label: 'Software', w: 40 }, { id: 'version', label: 'Version', w: 25 }] }] },
      { title: 'Problems found and fixed', fields: [{ id: 'issues', type: 'table', label: 'Problems', columns: [{ id: 'problem', label: 'Problem', w: 45 }, { id: 'resolution', label: 'What was done', w: 45 }, { id: 'closed', label: 'Closed', w: 10, type: 'select', options: ['Yes', 'No'] }] }] },
      { title: 'Photos', fields: [{ id: 'photos', type: 'photos', label: 'Photos' }] },
      { title: 'Handover notes', fields: [{ id: 'handover', type: 'textarea', label: 'Anything the customer needs to know' }] },
      { title: 'Sign-off', fields: [{ id: 'signoff', type: 'signoff', label: 'Signed', who: ['Commissioning engineer', 'For the customer'] }] },
    ],
  },
  {
    id: 'loop-check', name: 'Loop Check Sheets', group: 'Site', audience: 'customer', disciplines: [], landscape: true, spreadsheet: true,
    title: 'Loop Check Sheets', intro: 'Each instrument loop checked from the field device to the control system.',
    header: ['customer_order', 'site'],
    sections: [{ title: 'Loops', fields: [{ id: 'loops', type: 'table', label: 'Loops', columns: [
      { id: 'tag', label: 'Tag', w: 10 }, { id: 'description', label: 'Description', w: 22 }, { id: 'type', label: 'Type', w: 6, type: 'select', options: ['DI', 'DO', 'AI', 'AO'] },
      { id: 'range', label: 'Range', w: 9 }, { id: 'p0', label: '0%', w: 6 }, { id: 'p50', label: '50%', w: 6 }, { id: 'p100', label: '100%', w: 6 },
      { id: 'result', label: 'Result', w: 9, type: 'select', options: PASS }, { id: 'date', label: 'Date', w: 9, type: 'date' }, { id: 'initials', label: 'Initials', w: 7 }, { id: 'notes', label: 'Notes', w: 10 }] }] }],
  },
  {
    id: 'sat', name: 'Site Acceptance Test', group: 'Site', audience: 'customer', disciplines: [],
    title: 'Site Acceptance Test', intro: 'The tests carried out on site with the customer, and their results.',
    header: ['customer_order', 'site', 'test_date'],
    sections: [
      { title: 'Attendees', fields: [{ id: 'attendees', type: 'table', label: 'Attendees', columns: [{ id: 'name', label: 'Name', w: 35 }, { id: 'company', label: 'Company', w: 35 }, { id: 'role', label: 'Role', w: 30 }] }] },
      { title: 'Tests', fields: [{ id: 'tests', type: 'tests', label: 'Tests', columns: TEST_COLUMNS_FAT, witness: true }] },
      { title: 'Outstanding items', fields: [{ id: 'punch', type: 'table', label: 'Outstanding items', columns: [
        { id: 'item', label: 'Item', w: 45 }, { id: 'action', label: 'Action', w: 30 }, { id: 'owner', label: 'Who', w: 13 }, { id: 'due', label: 'By', w: 12, type: 'date' }] }] },
      { title: 'Sign-off', fields: [{ id: 'signoff', type: 'signoff', label: 'Signed', who: ['For Promtek', 'For the customer'] }] },
    ],
  },
  {
    id: 'calibration', name: 'Calibration Report', group: 'Site', audience: 'customer', disciplines: [],
    title: 'Calibration Report', intro: 'The instruments calibrated, the readings found and left, and the equipment used.',
    header: ['customer_order', 'site', 'test_date'],
    sections: [
      { title: 'Reference equipment', fields: [{ id: 'equipment', type: 'table', label: 'Equipment', columns: [{ id: 'item', label: 'Equipment', w: 40 }, { id: 'serial', label: 'Serial No', w: 25 }, { id: 'cert', label: 'Certificate', w: 20 }, { id: 'due', label: 'Due', w: 15, type: 'date' }] }] },
      { title: 'Instruments', fields: [{ id: 'instruments', type: 'table', label: 'Instruments', columns: [
        { id: 'tag', label: 'Tag', w: 12 }, { id: 'instrument', label: 'Instrument', w: 22 }, { id: 'range', label: 'Range', w: 12 }, { id: 'point', label: 'Test point', w: 12 },
        { id: 'found', label: 'As found', w: 10 }, { id: 'left', label: 'As left', w: 10 }, { id: 'tolerance', label: 'Tolerance', w: 10 }, { id: 'result', label: 'Result', w: 12, type: 'select', options: PASS }] }] },
      { title: 'Sign-off', fields: [{ id: 'signoff', type: 'signoff', label: 'Signed', who: ['Calibrated by'] }] },
    ],
  },
  {
    id: 'training', name: 'Training Record', group: 'Site', audience: 'customer', disciplines: [],
    title: 'Training Record', intro: 'The training Promtek gave, and who attended.',
    header: ['customer_order', 'site', 'test_date'],
    sections: [
      { title: 'What was covered', fields: [{ id: 'topics', type: 'checklist', label: 'Topics', items: ['Starting and stopping the system', 'Running batches', 'Alarms and what to do', 'Resetting after a fault', 'Reports', 'Routine maintenance'], answers: YES }] },
      { title: 'Attendees', fields: [{ id: 'attendees', type: 'table', label: 'Attendees', columns: [{ id: 'name', label: 'Name', w: 40 }, { id: 'role', label: 'Role', w: 35 }, { id: 'shift', label: 'Shift', w: 25 }] }] },
      { title: 'Sign-off', fields: [{ id: 'signoff', type: 'signoff', label: 'Signed', who: ['Trainer', 'For the customer'] }] },
    ],
  },
  {
    id: 'handover', name: 'Handover Certificate', group: 'Site', audience: 'customer', disciplines: [],
    title: 'Handover Certificate', intro: 'Confirms the system has been handed over to the customer.',
    header: ['customer_order', 'site'],
    sections: [
      { title: 'Scope delivered', fields: [{ id: 'scope', type: 'textarea', label: 'What was supplied' }] },
      { title: 'Documents handed over', fields: [{ id: 'documents', type: 'docs', label: 'Documents' }] },
      { title: 'Outstanding items', fields: [{ id: 'outstanding', type: 'table', label: 'Outstanding', columns: [{ id: 'item', label: 'Item', w: 60 }, { id: 'owner', label: 'Who', w: 20 }, { id: 'due', label: 'By', w: 20, type: 'date' }] }] },
      { title: 'Warranty', fields: [{ id: 'warranty', type: 'date', label: 'Warranty starts' }] },
      { title: 'Acceptance', fields: [{ id: 'signoff', type: 'signoff', label: 'Signed', who: ['For Promtek', 'For the customer'] }] },
    ],
  },

  // ---------- Condor ----------
  {
    id: 'condor-config', name: 'Condor Configuration Record', group: 'Condor', audience: 'internal', disciplines: ['condor'],
    title: 'Condor Configuration Record', intro: 'How Condor is set up on this site.',
    header: ['customer_order', 'site', 'software_version'],
    sections: [
      { title: 'Servers', fields: [{ id: 'servers', type: 'table', label: 'Servers', columns: [{ id: 'name', label: 'Server', w: 18 }, { id: 'role', label: 'Role', w: 22 }, { id: 'os', label: 'Operating system', w: 20 }, { id: 'ip', label: 'IP address', w: 18 }, { id: 'version', label: 'Version', w: 22 }] }] },
      { title: 'Integrations', fields: [{ id: 'integrations', type: 'table', label: 'Integrations', columns: [{ id: 'system', label: 'System', w: 25 }, { id: 'direction', label: 'Direction', w: 15, type: 'select', options: ['Into Condor', 'Out of Condor', 'Both'] }, { id: 'method', label: 'How', w: 25 }, { id: 'notes', label: 'Notes', w: 35 }] }] },
      { title: 'Modules and settings', fields: [{ id: 'modules', type: 'checklist', label: 'Modules', items: ['MES', 'Scheduling', 'Cross contamination rules', 'Importer (API)', 'Reporting', 'Time in Motion and Energy'], answers: YES }, { id: 'settings', type: 'textarea', label: 'Settings particular to this site' }] },
      { title: 'Users and roles', fields: [{ id: 'roles', type: 'table', label: 'Roles', columns: [{ id: 'role', label: 'Role', w: 30 }, { id: 'can', label: 'What they can do', w: 50 }, { id: 'who', label: 'Who', w: 20 }] }] },
      { title: 'Backups and scheduled jobs', fields: [{ id: 'jobs', type: 'textarea', label: 'Backups and scheduled jobs' }] },
    ],
  },
  {
    id: 'condor-manual', name: 'Condor User Manual', group: 'Condor', audience: 'customer', disciplines: [],
    title: 'Condor User Manual', intro: 'How to use Condor on this site.',
    header: ['customer_order', 'software_version'],
    sections: [
      { title: 'Introduction', fields: [{ id: 'intro', type: 'textarea', label: 'Introduction', rows: 5 }] },
      { title: 'Access', fields: [{ id: 'access', type: 'textarea', label: 'How to log in, and who gives access' }] },
      { title: 'Using Condor', fields: [{ id: 'areas', type: 'chapters', label: 'Section', fields: [
        { id: 'overview', type: 'textarea', label: 'Overview' }, { id: 'steps', type: 'steps', label: 'How to' }, { id: 'screens', type: 'photos', label: 'Screens' }, { id: 'notes', type: 'textarea', label: 'Notes' }] }] },
    ],
  },

  // ---------- any ----------
  {
    id: 'lessons', name: 'Lessons Learned', group: 'Internal', audience: 'internal', disciplines: [],
    title: 'Lessons Learned', intro: 'What this job taught us, for quoting and running the next one.',
    header: [],
    sections: [
      { title: 'What went well', fields: [{ id: 'well', type: 'textarea', label: 'What went well' }] },
      { title: 'What could have gone better', fields: [{ id: 'better', type: 'textarea', label: 'What could have gone better' }] },
      { title: 'For quoting', fields: [{ id: 'quoting', type: 'textarea', label: 'What to allow for next time' }] },
    ],
  },
];

// The details at the top of a document, besides the date, order and customer.
export const HEADER_FIELDS = {
  customer_order: { label: 'Customer order number', type: 'text' },
  site: { label: 'Site address', type: 'textarea' },
  software_version: { label: 'Software version', type: 'text' },
  panel: { label: 'Panel reference', type: 'text' },
  test_date: { label: 'Date of test', type: 'date' },
  visit_dates: { label: 'Dates on site', type: 'text' },
  site_contact: { label: 'Site contact', type: 'text' },
};

// A document made up in the hub by an admin, from the plain sections they give it.
export function customTemplate(t) {
  const sections = (t.sections?.length ? t.sections : ['Details']).map((title, i) => ({
    title: String(title),
    fields: [{ id: `s${i}_text`, type: 'textarea', label: String(title) }, { id: `s${i}_photos`, type: 'photos', label: 'Pictures' }],
  }));
  return { title: t.name, intro: t.intro || '', header: ['customer_order'], sections: [...sections, { title: 'Files', fields: [{ id: 'files', type: 'files', label: 'Files' }] }] };
}

// Every field in a template, chapters' fields included, flattened.
export function fieldsOf(template) {
  return (template.sections || []).flatMap((s) => s.fields || []);
}
