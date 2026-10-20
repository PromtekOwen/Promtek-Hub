// The shape of a survey: its sections, the fields on each item, and the
// wording used for conditions. Kept apart so both the app and the PDF can
// read it without importing each other.
// The sections of a survey, and the fields on each item.
export const SECTIONS = [
  { id: 'controlServers', name: 'Control servers', library: 'controlPCs', fixed: ['RMX Control Server', 'Intime Control Server', 'Kestrel Server', 'Condor Server', 'Livelink Server'],
    fields: [['os', 'Operating system'], ['cpu', 'CPU'], ['ram', 'RAM'], ['hdd', 'HDD / storage'], ['ip', 'IP address'], ['subnet', 'Subnet'], ['gateway', 'Gateway']],
    columns: { os: 'Operating System', cpu: 'CPU', ram: 'RAM', hdd: 'HDD / Storage' }, commentsBy: [] },
  { id: 'vdus', name: 'VDUs and client PCs', library: 'vdus', addLabel: 'VDU',
    fields: [['os', 'Operating system'], ['cpu', 'CPU'], ['ram', 'RAM'], ['hdd', 'HDD / storage'], ['partNo', 'Part no'], ['dom', 'Date of manufacture'], ['ip', 'IP address'], ['subnet', 'Subnet'], ['gateway', 'Gateway']],
    columns: { os: 'Operating System', cpu: 'CPU', ram: 'RAM', hdd: 'HDD / Storage', partNo: 'Part No' }, commentsBy: [] },
  { id: 'lcAmps', name: 'Load cell amplifiers', library: 'lcAmps', addLabel: 'AW',
    fields: [['partNo', 'Part no'], ['hwRev', 'Hardware rev'], ['swRev', 'Software rev'], ['serialNo', 'Serial no'], ['dom', 'Date of manufacture']],
    columns: { partNo: 'Part No', hwRev: 'Hardware Rev', swRev: 'Software Rev' }, commentsBy: ['partNo'], fillFrom: 'partNo' },
  { id: 'loadCells', name: 'Load cells', library: 'loadCells', addLabel: 'AW',
    fields: [['manufacturer', 'Manufacturer'], ['partNo', 'Part no'], ['mvv', 'mV/V'], ['serialNo', 'Serial no']],
    columns: { manufacturer: 'Manufacturer', partNo: 'Part No', mvv: 'mV/V' }, commentsBy: ['partNo'], fillFrom: 'partNo' },
  { id: 'plcCards', name: 'PLC panels', library: 'plcCards', addLabel: 'Panel', cards: true,
    fields: [['cardType', 'Card type'], ['manufacturer', 'Manufacturer'], ['partNo', 'Part number'], ['voltage', 'Control voltage'], ['density', 'Density / I/O count']],
    columns: { cardType: 'Card Type', manufacturer: 'Manufacturer', partNo: 'Part Number', voltage: 'Control Voltage', density: 'Density / I/O Count' },
    commentsBy: ['partNo'], fillFrom: 'partNo' },
  { id: 'software', name: 'Software', library: 'software', addLabel: 'Software',
    fields: [['version', 'Version'], ['filename', 'Filename'], ['fileVersion', 'File version'], ['dateModified', 'Date modified']],
    columns: { label: 'Title', version: 'Version Number', filename: 'Filename', fileVersion: 'File Version' }, commentsBy: ['label'], fillFrom: 'label' },
  { id: 'criticalSpares', name: 'Critical spares', library: 'criticalSpares', addLabel: 'Spare', spares: true,
    fields: [['area', 'Area'], ['inStock', 'In stock']],
    columns: { description: 'Description', area: 'Area' } },
];

// Serial numbers and network addresses belong to one unit, so they are never
// suggested, learned, or carried over when an item is duplicated.
export const UNIQUE_FIELDS = ['serialNo', 'ip', 'subnet', 'gateway'];

export const CARD_TYPES = ['Processor', 'Digital Input', 'Digital Output', 'Analogue Input', 'Analogue Output', 'Power Supply'];
export const CONDITIONS = ['Active', 'Active mature', 'Obsolete', 'End of life'];

