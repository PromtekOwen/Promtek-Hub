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
 */

const SHARED_SECRET = 'CHANGE-ME-to-a-long-random-string';
const FALLBACK_RECIPIENT = 'owen.hume@promtek.com';

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    if (payload.secret !== SHARED_SECRET) {
      return ContentService.createTextOutput('Rejected');
    }
    GmailApp.sendEmail(
      payload.to || FALLBACK_RECIPIENT,
      payload.subject || 'Promtek Hub alert',
      payload.body || ''
    );
    return ContentService.createTextOutput('Sent');
  } catch (err) {
    console.error(err);
    return ContentService.createTextOutput('Error: ' + err.message);
  }
}

function doGet() {
  return ContentService.createTextOutput('Promtek Hub mail relay is running.');
}
