const { fetchPayment, productPaymentMatches, verifyDownloadToken, fetchPrivatePdf } = require('./_lib/payment');

module.exports = async function download(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  const claims = verifyDownloadToken(req.query?.token);
  if (!claims) return res.status(401).send('Ссылка недействительна или срок её действия истёк.');
  try {
    const payment = await fetchPayment(claims.paymentId);
    if (!productPaymentMatches(payment, claims.email)) return res.status(403).send('Оплата не подтверждена.');
    const pdf = await fetchPrivatePdf();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Content-Disposition', 'attachment; filename="LAVRIK_SWIM_Tekhnika_krolya_4_nedeli.pdf"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(pdf);
  } catch (error) {
    console.error('Protected download failed:', error.message);
    return res.status(503).send('Не удалось подготовить файл. Попробуйте позже.');
  }
};
