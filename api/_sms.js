// Envío de códigos 2FA por SMS.
// - Modo twilio: Twilio Verify (custodia código, vigencia e intentos).
//   Requiere env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID.
// - Modo local (dev): genera el código aquí, lo imprime en el log del
//   servidor (nunca viaja al cliente) y el caller guarda su SHA256.
//   NO usar en producción: pedir credenciales Twilio para SMS real.
const crypto = require('crypto');

function smsMode() {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SID) {
    return 'twilio';
  }
  return 'local';
}

// Envía el código. Retorna {mode, code?} — code solo existe en modo local
// y el caller debe guardar únicamente su hash.
async function sendCode(phone) {
  if (smsMode() === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const tok = process.env.TWILIO_AUTH_TOKEN;
    const svc = process.env.TWILIO_VERIFY_SID;
    const r = await fetch('https://verify.twilio.com/v2/Services/' + svc + '/Verifications', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: phone, Channel: 'sms' })
    });
    if (!r.ok) {
      const e = new Error('No se pudo enviar el SMS (Twilio ' + r.status + ')');
      e.status = 502;
      throw e;
    }
    return { mode: 'twilio' };
  }
  const code = String(crypto.randomInt(100000, 1000000));
  console.log('[SMS-LOCAL] codigo para ' + phone + ': ' + code);
  return { mode: 'local', code };
}

// Valida el código en modo twilio. En modo local lo hace auth.js contra el hash.
async function checkCodeRemote(phone, code) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  const svc = process.env.TWILIO_VERIFY_SID;
  const r = await fetch('https://verify.twilio.com/v2/Services/' + svc + '/VerificationCheck', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ To: phone, Code: String(code) })
  });
  if (!r.ok) return false;
  const j = await r.json();
  return j.valid === true || j.status === 'approved';
}

module.exports = { smsMode, sendCode, checkCodeRemote };
