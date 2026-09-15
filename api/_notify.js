// Envío de códigos 2FA por EMAIL (reemplaza SMS/Twilio).
// - Modo resend: API HTTP de Resend (free tier: 3.000 mails/mes).
//   Requiere env RESEND_API_KEY. El remitente onboarding@resend.dev entrega
//   al propio email de la cuenta Resend: la cuenta debe crearse con el mismo
//   email 2FA del administrador.
// - Modo local (dev): imprime el código en el log del servidor (nunca viaja
//   al cliente). El caller guarda siempre SHA256(code) en otp_codes.
//   NO usar en producción: pedir API key de Resend para envío real.
function mailMode() {
  return process.env.RESEND_API_KEY ? 'resend' : 'local';
}

function codeEmailHtml(code) {
  return '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">'
    + '<h2 style="color:#0B1220">Cotizador Energy Sur SpA</h2>'
    + '<p>Tu código de verificación es:</p>'
    + '<p style="font-size:36px;font-weight:900;letter-spacing:8px;color:#0B1220">' + code + '</p>'
    + '<p style="color:#5B657A">Vigencia: 10 minutos. Si no lo pediste, ignora este correo.</p>'
    + '</div>';
}

// to: email destino. code: 6 dígitos generados por el caller.
async function sendCode(to, code) {
  if (mailMode() === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Cotizador Energy Sur <onboarding@resend.dev>',
        to: [to],
        subject: 'Tu código de verificación: ' + code,
        html: codeEmailHtml(code),
        text: 'Tu código de verificación Energy Sur: ' + code + ' (vigencia 10 minutos).'
      })
    });
    if (!r.ok) {
      const e = new Error('No se pudo enviar el email (Resend ' + r.status + ')');
      e.status = 502;
      throw e;
    }
    return { mode: 'resend' };
  }
  console.log('[MAIL-LOCAL] codigo para ' + to + ': ' + code);
  return { mode: 'local' };
}

module.exports = { mailMode, sendCode };
