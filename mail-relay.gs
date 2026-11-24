/**
 * Promtek Hub mail relay.
 *
 * The hub can't send email by itself, so it posts alerts here and this script
 * sends them from your Google account. See Part 11 of SETUP.md.
 *
 * 1. Go to script.google.com and create a new project called "Promtek Hub mail relay".
 * 2. Paste this file in, replacing anything already there.
 * 3. Change SHARED_SECRET to a long random string of your own.
 * 4. Deploy > New deployment > Web app.
 *      Execute as: Me.      Who has access: Anyone.
 * 5. Copy the web app URL into the Worker's ALERT_WEBHOOK_URL secret, and the
 *    same secret string into ALERT_WEBHOOK_SECRET.
 *
 * When this file changes: paste it in again (keeping your SHARED_SECRET), then Deploy >
 * Manage deployments > edit (the pencil) > Version: New version > Deploy. The URL stays the same.
 */

const SHARED_SECRET = 'CHANGE-ME-to-a-long-random-string';
// Where the hub's emails may go. Anything else is dropped, so the relay can't be used to email anyone else.
const ALLOWED_DOMAINS = ['promtek.com', 'promtek.co.za'];

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    if (SHARED_SECRET.indexOf('CHANGE-ME') === 0 || payload.secret !== SHARED_SECRET) {
      return ContentService.createTextOutput('Rejected');
    }
    const to = String(payload.to || '').split(',').map(function (a) { return a.trim(); })
      .filter(function (a) {
        const at = a.lastIndexOf('@');
        return at > 0 && !/\s/.test(a) && ALLOWED_DOMAINS.indexOf(a.slice(at + 1).toLowerCase()) >= 0;
      }).join(',');
    // Nobody to send it to: dropped, rather than sent to whoever runs the relay.
    if (!to) return ContentService.createTextOutput('Skipped: no Promtek address');
    // Sent from the no-reply address, so anything that can't be delivered isn't sent back to
    // whoever runs the relay.
    GmailApp.sendEmail(to, payload.subject || 'Promtek Hub alert', payload.body || '', { name: 'Promtek Hub', noReply: true });
    return ContentService.createTextOutput('Sent');
  } catch (err) {
    console.error(err);
    return ContentService.createTextOutput('Error: ' + err.message);
  }
}

function doGet() {
  return ContentService.createTextOutput('Promtek Hub mail relay is running.');
}
