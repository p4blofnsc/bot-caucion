require('dotenv').config()

const {
  procesarCauciones,
  notificarSiCorresponde,
  esHorarioDeMercado,
} = require('./bot')

async function main() {
  if (!esHorarioDeMercado()) {
    console.log('Fuera de horario de mercado. No se escanea.')
    return
  }

  const { todas, oportunidades } = await procesarCauciones()

  console.log(
    `Escaneo OK. Total: ${todas.length}. Oportunidades (> ${process.env.MIN_TNA}%): ${oportunidades.length}`
  )

  await notificarSiCorresponde(oportunidades)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
