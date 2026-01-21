const axios = require('axios')
const cheerio = require('cheerio')
const twilio = require('twilio')
const dayjs = require('dayjs')
const puppeteer = require('puppeteer')

const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone')
const isBetween = require('dayjs/plugin/isBetween')
const customParseFormat = require('dayjs/plugin/customParseFormat')

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(isBetween)
dayjs.extend(customParseFormat)

function createTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
}

async function obtenerCauciones() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })

  try {
    const page = await browser.newPage()
    await page.goto('https://www.dolarito.ar/merval/cauciones', {
      waitUntil: 'networkidle0',
      timeout: 30000,
    })

    await page.waitForSelector('table', { timeout: 15000 })

    const cauciones = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'))
      const result = []

      for (const row of rows) {
        const cols = row.querySelectorAll('td')
        if (cols.length < 2) continue

        const colPlazo = cols[0].innerText.trim()
        const colTasa = cols[1].innerText.trim()

        const matchPlazo = colPlazo.match(/(\d+)/)
        const plazo_dias = matchPlazo ? parseInt(matchPlazo[1], 10) : NaN

        const matchTasa = colTasa
          .replace(/\s/g, '')
          .replace(',', '.')
          .match(/([\d.]+)/)
        const tasa_actual = matchTasa ? parseFloat(matchTasa[1]) : NaN

        if (!Number.isNaN(plazo_dias) && !Number.isNaN(tasa_actual)) {
          result.push({ plazo_dias, tasa_actual })
        }
      }

      return result.sort((a, b) => b.tasa_actual - a.tasa_actual)
    })

    return cauciones
  } finally {
    await browser.close()
  }
}

async function procesarCauciones() {
  const todas = await obtenerCauciones()
  const minTNA = parseFloat(process.env.MIN_TNA || 0)
  const oportunidades = todas.filter((c) => c.tasa_actual > minTNA)
  return { todas, oportunidades }
}

async function notificarSiCorresponde(oportunidades) {
  if (!oportunidades || oportunidades.length === 0) return

  const client = createTwilioClient()

  let body = `🚀 *Oportunidades de Caución (> ${process.env.MIN_TNA}%)* 🚀\n\n`
  oportunidades.slice(0, 10).forEach((op) => {
    body += `📅 Plazo: ${op.plazo_dias} días - 📈 Tasa: ${op.tasa_actual}%\n`
  })

  const message = await client.messages.create({
    body,
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: process.env.TWILIO_WHATSAPP_TO,
  })

  console.log(`WhatsApp enviado. SID: ${message.sid} - Estado: ${message.status}`)
}

function esHorarioDeMercado() {
  const ahora = dayjs().tz('America/Argentina/Buenos_Aires')
  const diaSemana = ahora.day()

  if (diaSemana < 1 || diaSemana > 5) return false

  const base = ahora.startOf('day')
  const inicio = base.hour(10).minute(30).second(0).millisecond(0)
  const fin = base.hour(17).minute(30).second(0).millisecond(0)

  return ahora.isBetween(inicio, fin, null, '[]')
}

module.exports = {
  procesarCauciones,
  notificarSiCorresponde,
  esHorarioDeMercado,
}
