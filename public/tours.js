// Guides for each page: shown the first time someone opens it, and again from
// the ? in the page header. A step whose target isn't on screen is shown centred.
// `target` is a list of selectors; the first one found is highlighted. An
// `optional` step is left out when its target isn't there, such as a tab the
// person can't open.
export const TOURS = {
  '#/': [
    { title: 'Welcome to the hub', text: 'Everything you need day to day is here: logging time, jobs, quotes, site paperwork and more. This quick guide shows you around.' },
    { target: ['#band .summary'], title: 'Your level and rank', text: 'Time you log earns XP. Your level, title and ELO rank show here; tap to see where your XP came from.' },
    { target: ['.tiles'], title: 'Your tiles', text: 'Each tile opens a part of the hub. You see the ones that fit your job and team.' },
    { target: ['[data-tile="arrange"]'], title: 'Make it yours', text: 'Arrange tiles lets you drag them into the order you want and hide any you don\'t use.' },
    { target: ['#log-fab'], title: 'Log time', text: 'Add time you\'ve already done, or start a timer on a job. While a timer is running, this shows the job and its clock.' },
    { target: ['.help-tour'], title: 'Help on every page', text: 'Each page has its own short guide the first time you open it. Tap ? at any time to see it again.' },
  ],
  '#/log': [
    { target: ['#log-search'], title: 'Find the job', text: 'Search by Jira key or by words from the summary. Your recent jobs are listed underneath.' },
    { target: ['[data-node]'], title: 'Or browse to it', text: 'Step down from the customer to the order, category and stage. Logging against the stage is worth the most XP.' },
    { title: 'Two ways to log', text: 'After choosing a job, pick Add time already done to enter a start time and how long, or Start the timer to time it as you go.' },
    { target: ['#tracker-panel'], title: 'The timer', text: 'Pause and carry on as you need: each stretch goes to Tempo with its own start and end. If a colleague needs you, use Assisting so that time is logged separately and your job picks up where it left off.' },
  ],
  '#/xp': [
    { target: ['#band'], title: 'Your progress', text: 'Your level and title come from the XP you\'ve earned. Your ELO rank reflects how you do on jobs against how hard they are.' },
    { target: ['#leaderboard'], title: 'Leaderboard', text: 'See how you compare this week, this month or all time, and filter by team.' },
  ],
  '#/time': [
    { target: ['.week-nav'], title: 'Week by week', text: 'Your Tempo time for the week, day by day. Use the arrows to look back at earlier weeks.' },
  ],
  '#/jobs': [
    { target: ['#view .card', '#view'], title: 'Your open jobs', text: 'Each order and its categories, how hard each part is, and how the time logged compares with the estimate.' },
    { title: 'If an estimate looks wrong', text: 'When a category is running close to or past its estimate, you can raise a dispute with what changed. A team lead reviews it.' },
  ],
  '#/quotes': [
    { optional: true, target: ['[data-q-new-open]'], title: 'Start a quote', text: 'Pick the customer, give it a title and description, and choose the categories. The quote is made in Jira straight away.' },
    { title: 'Estimating each category', text: 'Add the counts and conditions, best, likely and worst hours, and how hard it is. Similar finished jobs are shown to compare against, and you can ask an engineer for their view.' },
    { title: 'Asked for an estimate?', text: 'Requests for your view appear on this page. Give your hours and difficulty; they go to the quote and to Jira.' },
  ],
  '#/condor': [
    { target: ['.condor-tabs'], title: 'Condor Dev', text: 'Everything for MES development is here, under these tabs.' },
    { optional: true, target: ['[data-condor-tab="day"]'], title: 'My day', text: 'Your Bitbucket work turned into draft time. Check the hours and log the day to Tempo in one go.' },
    { optional: true, target: ['[data-condor-tab="estimate"]'], title: 'Estimate', text: 'Estimate a ticket by comparing it with finished ones: is it smaller, about the same, or bigger?' },
    { optional: true, target: ['[data-condor-tab="triage"]'], title: 'Triage', text: 'At the start of a release, go through open tickets: Must, Should, Could, or not this time. Then make the release\'s sprints in Jira.' },
    { optional: true, target: ['[data-condor-tab="plan"]'], title: 'Plan', text: 'Who is doing what and when, against everyone\'s capacity, with suggestions when work won\'t fit.' },
    { optional: true, target: ['[data-condor-tab="ratings"]'], title: 'Ratings', text: 'Your Condor development rating and how it has changed ticket by ticket.' },
  ],
  '#/pow': [
    { target: ['#view .card', '#view'], title: 'Before you start on site', text: 'Fill in the risk assessment for the visit. It works without signal and sends when you\'re back online.' },
    { title: 'When you finish', text: 'The assessment becomes a PDF, attached to the Jira item and filed in the shared drive.' },
  ],
  '#/obs': [
    { target: ['#view .card', '#view'], title: 'Site surveys', text: 'Record the equipment on site and its condition. The finished survey is saved as a PDF and filed for sales to quote from.' },
  ],
  '#/calls': [
    { target: ['#calls-date', '#view .card'], title: 'Your calls', text: 'Choose a day to load the calls you took through 8x8.' },
    { title: 'Turn a call into time', text: 'Log a call\'s time against the job it was about, or raise a new service ticket from it, in a couple of taps.' },
  ],
  '#/it': [
    { target: ['#view .card', '#view'], title: 'IT support', text: 'Report a problem or ask for something you need. It\'s raised in your name, and you can add the equipment and photos.' },
  ],
  '#/vehicles': [
    { target: ['#view .card', '#view'], title: 'Booking a vehicle', text: 'Book a vehicle by the hour for when you need it.' },
    { title: 'Before you drive', text: 'Do the walkaround check. Anything that fails is reported as a defect so it can be fixed.' },
  ],
  '#/org': [
    { target: ['.org-scroll', '#view'], title: 'The company chart', text: 'Who reports to whom, and each person\'s role. Scroll sideways on a small screen.' },
    { optional: true, target: ['[data-org="download"]'], title: 'Save a copy', text: 'Download the chart as an image.' },
  ],
  '#/reports': [
    { target: ['[data-view="team"]', '#view .tabs'], title: 'Reports', text: 'Effort shows time logged week by week, Quoting shows how jobs ran against their estimates, and Stages shows how long each stage usually takes.' },
    { optional: true, target: ['[data-report-team]'], title: 'Choose a team', text: 'Look at one team or everyone. Your own team is chosen to start with.' },
  ],
  '#/requests': [
    { target: ['.req-form', '#view'], title: 'Ask for something', text: 'Ask for a new tile or a change, or tell us about something that isn\'t working. The more detail, the better.' },
    { title: 'Following it up', text: 'Your requests are listed here with where they\'ve got to, and any reply. You\'ll get an email when one moves on.' },
  ],
  '#/shop': [
    { target: ['#view .card', '#view'], title: 'The XP shop', text: 'Rewards you\'ll be able to spend your levels on, and what each would cost.' },
  ],
  '#/admin': [
    { target: ['details.admin-section', '#view'], title: 'Admin sections', text: 'Each section opens and closes. The ones you open stay open next time.' },
    { target: ['details[data-section="employees"]'], title: 'Employees', text: 'Each person\'s details, groups, teams and extension.' },
    { target: ['details[data-section="audit-log"]'], title: 'Audit log', text: 'Every change made by hand, who made it and what it was before.' },
  ],
};
