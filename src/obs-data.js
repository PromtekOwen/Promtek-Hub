// The shape of a survey: its sections, the fields on each item, and the
// wording used for conditions. Kept apart so both the app and the PDF can
// read it without importing each other.
// The sections of a survey, and the fields on each item.
export const SECTIONS = [
  { id: 'controlServers', name: 'Control servers', library: 'controlPCs', fixed: ['RMX Control Server', 'Intime Control Server', 'Kestrel Server', 'Condor Server', 'Livelink Server'],
    fields: [['os', 'Operating system'], ['cpu', 'CPU'], ['ram', 'RAM'], ['hdd', 'HDD / storage'], ['ip', 'IP address'], ['subnet', 'Subnet'], ['gateway', 'Gateway']] },
  { id: 'vdus', name: 'VDUs and client PCs', library: 'vdus', addLabel: 'VDU',
    fields: [['os', 'Operating system'], ['cpu', 'CPU'], ['ram', 'RAM'], ['hdd', 'HDD / storage'], ['partNo', 'Part no'], ['dom', 'Date of manufacture'], ['ip', 'IP address'], ['subnet', 'Subnet'], ['gateway', 'Gateway']] },
  { id: 'lcAmps', name: 'Load cell amplifiers', library: 'lcAmps', addLabel: 'AW',
    fields: [['partNo', 'Part no'], ['hwRev', 'Hardware rev'], ['swRev', 'Software rev'], ['serialNo', 'Serial no'], ['dom', 'Date of manufacture']] },
  { id: 'loadCells', name: 'Load cells', library: 'loadCells', addLabel: 'AW',
    fields: [['partNo', 'Part no'], ['manufacturer', 'Manufacturer'], ['mvv', 'mV/V'], ['serialNo', 'Serial no']] },
  { id: 'plcCards', name: 'PLC panels', library: 'plcCards', addLabel: 'Panel', cards: true,
    fields: [['manufacturer', 'Manufacturer'], ['partNo', 'Part number'], ['cardType', 'Card type'], ['voltage', 'Control voltage'], ['density', 'Density / I/O count']] },
  { id: 'software', name: 'Software', library: 'software', addLabel: 'Software',
    fields: [['version', 'Version'], ['filename', 'Filename'], ['fileVersion', 'File version'], ['dateModified', 'Date modified']] },
  { id: 'criticalSpares', name: 'Critical spares', library: 'criticalSpares', addLabel: 'Spare', spares: true,
    fields: [['area', 'Area'], ['inStock', 'In stock']] },
];

export const CARD_TYPES = ['Processor', 'Digital Input', 'Digital Output', 'Analogue Input', 'Analogue Output', 'Power Supply'];
export const CONDITIONS = ['Active', 'Active mature', 'Obsolete', 'End of life'];

