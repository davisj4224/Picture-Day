'use strict';

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const PAGE = { width: 612, height: 792 }; // US Letter, points
const MARGIN = 28;
const COLS = 2;
const ROWS = 4;

/**
 * Streams a printable sheet of QR cards, 8 per page.
 * Each card: big QR, student name, class info, and the code in plain text
 * so a card is still usable if the QR ever fails to read.
 */
async function streamCards(students, { schoolName, eventName, year }, res) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
  doc.pipe(res);

  const cardW = (PAGE.width - MARGIN * 2) / COLS;
  const cardH = (PAGE.height - MARGIN * 2) / ROWS;

  for (let i = 0; i < students.length; i++) {
    const s = students[i];
    const slot = i % (COLS * ROWS);
    if (i > 0 && slot === 0) doc.addPage();

    const col = slot % COLS;
    const row = Math.floor(slot / COLS);
    const x = MARGIN + col * cardW;
    const y = MARGIN + row * cardH;

    // cut guide
    doc
      .save()
      .lineWidth(0.5)
      .dash(3, { space: 3 })
      .strokeColor('#BFC6BF')
      .rect(x + 4, y + 4, cardW - 8, cardH - 8)
      .stroke()
      .restore();

    const png = await QRCode.toBuffer(s.qr_code, {
      errorCorrectionLevel: 'H',
      margin: 1,
      width: 600
    });

    const qrSize = cardH - 44;
    doc.image(png, x + 18, y + 22, { width: qrSize, height: qrSize });

    const textX = x + 18 + qrSize + 14;
    const textW = cardW - (textX - x) - 20;

    doc
      .fillColor('#16202B')
      .font('Helvetica-Bold')
      .fontSize(15)
      .text(`${s.first_name} ${s.last_name}`, textX, y + 30, { width: textW });

    const meta = [s.grade ? `Grade ${s.grade}` : null, s.teacher || null, s.ext_id ? `ID ${s.ext_id}` : null]
      .filter(Boolean)
      .join('\n');

    doc.font('Helvetica').fontSize(10).fillColor('#5A6670').text(meta, textX, doc.y + 4, { width: textW });

    doc
      .font('Courier-Bold')
      .fontSize(11)
      .fillColor('#16505C')
      .text(s.qr_code, textX, y + cardH - 52, { width: textW });

    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#8A949B')
      .text(`${schoolName} · ${eventName} ${year} · photograph this card first`, textX, y + cardH - 36, {
        width: textW
      });
  }

  if (students.length === 0) {
    doc.font('Helvetica').fontSize(14).text('No students selected.', MARGIN, MARGIN);
  }

  doc.end();
}

module.exports = { streamCards };
