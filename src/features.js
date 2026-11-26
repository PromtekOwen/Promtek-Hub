// What the hub does, tile by tile, for the Features page (account menu → Features).
//
// Every new feature or tile gets a line here as part of the change that adds it, so the page
// keeps itself up to date with each deploy. Bug fixes and small look-and-feel changes don't.
// Each line needs an id that never changes (edits and hidden lines made in the hub are kept
// against it), the tile it belongs to (or 'general'), and the day it was added; the lines that
// describe what tiles already did before the page existed have no date.
//
// Wording can be changed, lines hidden and new ones added from the page itself, by anyone with
// "Edit features"; those changes are kept in the database and win over what's written here.

export const FEATURE_TILES = {
  general: 'General', xp: 'XP & rank', time: 'My time', condor: 'Condor Dev', quotes: 'Sales', jobs: 'Jobs', obsolescence: 'Obsolescence',
  pow: 'Point of work', customers: 'Customers', custfeedback: 'Customer Feedback', stock: 'Stock', coshh: 'COSHH', nearmiss: 'Near misses',
  psc: 'PSC', contracts: 'Service contracts', capacity: 'Capacity', ims: 'IMS', training: 'Training & Policy', wip: 'WIP', invoicing: 'Invoicing',
  calls: '8x8 calls', it: 'IT support', requests: 'Requests', feedback: 'Feedback', vehicles: 'Vehicles', eotq: 'Employee of the Quarter',
  shop: 'XP shop', org: 'Company chart', reports: 'Reports', admin: 'Admin',
};

const f = (tile, id, text, added = null) => ({ id: `${tile}.${id}`, tile, text, added });

export const FEATURES = [
  // General
  f('general', 'signin', 'Sign in with your Promtek Google account; the hub links you to your Atlassian account the first time'),
  f('general', 'install', 'Installs as an app on phones and computers, with its own icon and window'),
  f('general', 'home', 'Home screen with your tiles, arranged how you like, and company news and messages'),
  f('general', 'forms', 'Home screen forms and messages from admins, with multiple choice and written answers'),
  f('general', 'logtime', 'Log time from any page with the Log time button, with a running timer that sends each stretch to Tempo as it ends'),
  f('general', 'bell', 'Notifications under the bell, with each tile\'s own choice of what you hear about, in the hub, by email or both'),
  f('general', 'digest', 'Alert emails can come as one each morning, and several alerts at once arrive as a single email', '2026-11-21'),
  f('general', 'theme', 'Light, dark or follow-the-device appearance'),
  f('general', 'walkthroughs', 'A walkthrough of each tile the first time you open it, in practice mode with example data'),
  f('general', 'country', 'Promtek UK and Promtek Africa each see their own customers and items, with Promtek Africa in green'),
  f('general', 'tablet', 'The shared workshop tablet: pick your name and enter your PIN, and it works as you'),
  f('general', 'birthdays', 'Birthdays on the home screen and under the bell'),
  f('general', 'jiraasyou', 'Changes made in Jira from the hub show as the person who made them, once they\'ve connected their Jira account'),
  f('general', 'features', 'This Features page: what each tile does, and what\'s being worked on next', '2026-11-26'),

  // XP & rank
  f('xp', 'levels', 'XP for every hour logged, with levels and level titles'),
  f('xp', 'leaderboard', 'The leaderboard, with everyone\'s level and title'),
  f('xp', 'elo', 'ELO rank from finished jobs: beating the estimate raises it, with the best of the last three months shown'),
  f('xp', 'history', 'Your ELO history, job by job'),
  f('xp', 'modifiers', 'Ask for things to be taken into account (supporting apprentices, heavy workload, unwell and more), approved by your lead'),

  // My time
  f('time', 'week', 'Your week in Tempo, day by day, with what each log earned'),
  f('time', 'change', 'Change or delete a time log: date, start, length and note'),
  f('time', 'daystrip', 'A strip of what\'s already logged on the day, with gaps to tap and overlaps shown in red'),
  f('time', 'moveon', 'Move the Jira item on when you log time to it'),
  f('time', 'overtime', 'A running overtime balance carried from week to week'),
  f('time', 'check', 'Check a week against Tempo, to pick up changes made outside the hub'),

  // Condor Dev
  f('condor', 'day', 'Your development day from Bitbucket (commits, branches and pull requests), ready to log as time'),
  f('condor', 'triage', 'Triage MES tickets and plan releases'),
  f('condor', 'capacity', 'Each person\'s Condor hours, working days and time away, for planning'),
  f('condor', 'plan', 'A plan for the release, written back to Jira as start and due dates and sprints once accepted'),
  f('condor', 'psc', 'Service items sent over from PSC as MES bugs, with estimates'),

  // Sales
  f('quotes', 'estimates', 'Estimates you\'ve been asked for, to answer from the tile'),
  f('quotes', 'builder', 'Build a quote from what the job involves, with time per category predicted from past jobs'),
  f('quotes', 'prospects', 'Prospects: potential customers with no Jira project yet, their contacts, interests and next steps'),

  // Jobs
  f('jobs', 'list', 'Every open order with each category\'s job ELO and time logged against the estimate'),
  f('jobs', 'people', 'Who\'s on each category: the assignee and everyone involved'),
  f('jobs', 'filters', 'Filter by customer, team, category, assignee and status'),
  f('jobs', 'subtasks', 'Sub-tasks under each category, with a rough guide to each one\'s time'),
  f('jobs', 'difficulty', 'Rate a job\'s difficulty, and dispute it, with lead approval'),
  f('jobs', 'alerts', 'Alerts when a job reaches 90% and 100% of its estimate'),
  f('jobs', 'documents', 'Job documents: each category\'s documents, filled in together on the job and issued as Promtek PDFs on the Jira category', '2026-11-20'),
  f('jobs', 'docdrive', 'Issued documents filed straight into the job\'s Google Drive folder', '2026-11-20'),
  f('jobs', 'doctime', 'Time spent on documentation earns extra XP, and a category can\'t be closed while its documents are outstanding', '2026-11-20'),
  f('jobs', 'docsettings', 'Settings for team leads: the kinds of document, which are usual for each kind of category, and new kinds built from chosen fields', '2026-11-21'),
  f('jobs', 'docdrafts', 'Delete drafts, and work on anyone\'s draft together, live', '2026-11-22'),

  // Obsolescence
  f('obsolescence', 'survey', 'Survey a site section by section, with part numbers suggested from the equipment library'),
  f('obsolescence', 'report', 'The report as a PDF, attached to the Jira item and filed in the shared drive'),
  f('obsolescence', 'library', 'An equipment library that grows with every survey'),

  // Point of work
  f('pow', 'assessment', 'The point of work risk assessment, one part per screen, made into a PDF on the Jira visit and filed in the shared drive'),
  f('pow', 'offline', 'Works with no signal, and sends itself when signal returns'),
  f('pow', 'signature', 'The customer signs on the screen', '2026-11-22'),
  f('pow', 'feedback', 'The customer gives feedback on the visit before signing it off', '2026-11-22'),

  // Customers
  f('customers', 'list', 'Every customer with their open quotes, PSCs and jobs, and their service contract'),
  f('customers', 'contacts', 'Site addresses and contacts, with a primary contact'),
  f('customers', 'stats', 'Statistics for each customer: money and time by month, open work and response times'),

  // Customer Feedback
  f('custfeedback', 'responses', 'Feedback customers give after a visit: satisfaction, whether their issue was solved, and what they said', '2026-11-22'),
  f('custfeedback', 'followup', 'Follow-ups for poor scores, sales leads and testimonials, with alerts', '2026-11-22'),

  // Stock
  f('stock', 'workorders', 'Work orders from the open Hardware on customer orders, with the parts list read from the Purchase Order item', '2026-11-25'),
  f('stock', 'priority', 'Priority from the job\'s dates, with team-lead overrides and Emergency taking stock from lower-priority jobs', '2026-11-25'),
  f('stock', 'intake', 'Intake: scan what arrives, match it to the expected delivery, and get a suggested shelf', '2026-11-25'),
  f('stock', 'picking', 'Picking by scanning, with bins for screws and the like, and Hardware complete to lock what was used', '2026-11-25'),
  f('stock', 'checks', 'Stock checks: blind counts shared live between everyone counting, with variance and an Excel download', '2026-11-25'),
  f('stock', 'trace', 'Trace any unit\'s full history, and recall a batch to see which jobs and customers it went to', '2026-11-25'),
  f('stock', 'dashboard', 'Dashboard of what needs ordering, deliveries due and stock left on the bench', '2026-11-25'),
  f('stock', 'time', 'Suggested time logs from your stock scans', '2026-11-25'),
  f('stock', 'quoter', 'Stock items imported from Quoter', '2026-11-25'),
  f('stock', 'barcode', 'Shop barcodes looked up to fill in new items', '2026-11-25'),
  f('stock', 'labels', 'Supplier labels read for part numbers, quantity, lot, serial and PO', '2026-11-25'),
  f('stock', 'eachscan', 'Boxed items scanned in one at a time, each with its own label and batch number', '2026-11-25'),
  f('stock', 'deleted', 'Deleting required stock asks why, and deleted lines can be restored from the settings', '2026-11-25'),

  // COSHH
  f('coshh', 'assessments', 'An assessment for each substance kept, filed as a PDF laid out like the paper form'),
  f('coshh', 'reviews', 'Yearly reviews, with reminders when they\'re due'),
  f('coshh', 'pictures', 'Pictures of the containers, taken on the tablet'),

  // Near misses
  f('nearmiss', 'report', 'Report a near miss: when, where, who was involved and what happened'),
  f('nearmiss', 'review', 'Reports read and closed by those who review them, with an email for each new one'),

  // PSC
  f('psc', 'list', 'Every support request from the PSC board and customer projects, with the customer\'s contract tier'),
  f('psc', 'triage', 'Triage, pick up and work items, with response and resolution times against the contract'),
  f('psc', 'condor', 'Send an item to the Condor team as an MES bug'),
  f('psc', 'involve', 'Involve someone from the other country on an item'),

  // Service contracts
  f('contracts', 'list', 'Each customer\'s service contract: status, tier, visits done and tokens'),
  f('contracts', 'tracking', 'Contracts moved on automatically as dates arrive, with alerts'),
  f('contracts', 'insights', 'Insights across every contract'),

  // Capacity
  f('capacity', 'who', 'Who has what on, and who has room'),

  // IMS
  f('ims', 'items', 'The ten IMS projects and the main board as one list, with each item shown once across areas'),
  f('ims', 'stats', 'Statistics for each area'),
  f('ims', 'meetings', 'Meetings, with a gap analysis for each'),
  f('ims', 'gaps', 'Gap analysis: skills needed, people assessed by their line manager, and the actions that follow'),
  f('ims', 'marketing', 'Marketing work kept out of the statistics, with its own counts when looking at Marketing', '2026-11-24'),

  // Training & Policy
  f('training', 'matrix', 'The training matrix: each person\'s courses, when they\'re due again, and evidence'),
  f('training', 'toolbox', 'Tool box talks: coming up, to acknowledge and held'),
  f('training', 'policies', 'Policies to read and acknowledge'),

  // WIP
  f('wip', 'orders', 'Every order\'s value, progress and contract income, UK and South Africa'),
  f('wip', 'auto', 'Orders moved on automatically as their work progresses'),
  f('wip', 'workbook', 'Download the WIP as a workbook'),

  // Invoicing
  f('invoicing', 'board', 'Every invoice on the orders: overdue, due, waiting and paid, with payments expected'),
  f('invoicing', 'update', 'Set target ends, mark invoices sent or paid, and change due dates in Jira'),

  // 8x8 calls
  f('calls', 'fetch', 'Your calls from 8x8, day by day'),
  f('calls', 'log', 'Log a call to a job or PSC, or raise a new PSC from it'),

  // IT support
  f('it', 'request', 'Report a problem or ask for kit, raised in the IT service desk in your name'),

  // Requests
  f('requests', 'ask', 'Ask for a new tile or a change, or report something that isn\'t working'),
  f('requests', 'status', 'See your requests and their status'),
  f('requests', 'messages', 'Message the developers on a request, and get their replies, whatever its status', '2026-11-24'),

  // Feedback
  f('feedback', 'anonymous', 'Share feedback or an idea anonymously'),
  f('feedback', 'votes', 'Vote on posted feedback'),
  f('feedback', 'replies', 'Replies from management, without anyone knowing who wrote it'),

  // Vehicles
  f('vehicles', 'booking', 'Book a vehicle by the hour'),
  f('vehicles', 'check', 'The walkaround check, with faults reported and unsafe vehicles taken off the road'),
  f('vehicles', 'reminders', 'Reminders for MOT, insurance, tax and service dates'),

  // Employee of the Quarter
  f('eotq', 'nominate', 'Nominate someone who has gone above and beyond'),
  f('eotq', 'results', 'Results and the winner chosen by management, with medals on profiles'),

  // XP shop
  f('shop', 'demo', 'Rewards for levels, as a demonstration with nothing spent'),

  // Company chart
  f('org', 'chart', 'The company chart drawn from the employee list, with pictures and emergency badges'),
  f('org', 'download', 'Download the chart as an image'),
  f('org', 'versions', 'Chart versions issued for the IMS'),

  // Reports
  f('reports', 'weekly', 'Hours, XP, worklogs and days logged per person per week'),

  // Admin
  f('admin', 'employees', 'Employees: details, roles, teams, pictures and badges'),
  f('admin', 'access', 'Who can use what: every tile and permission by role and team'),
  f('admin', 'audit', 'An audit log of changes made by hand'),
  f('admin', 'usage', 'How often each tile is used'),
  f('admin', 'xprates', 'XP rates on Jira items'),
  f('admin', 'viewas', 'View the hub as someone else'),
];
