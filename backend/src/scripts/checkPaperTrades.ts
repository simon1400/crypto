import { prisma } from '../db/prisma'

async function main() {
  const trades = await prisma.levelsPaperTrade.findMany({
    where: { id: { in: [24, 25, 26] } },
    orderBy: { id: 'asc' },
  })
  for (const t of trades) {
    console.log(`#${t.id} ${t.symbol} ${t.side} status=${t.status}`)
    console.log(`  entry=${t.entryPrice} SL=${t.currentStop} initSL=${t.initialStop}`)
    console.log(`  TPs=${JSON.stringify(t.tpLadder)}`)
    console.log(`  lastPriceCheck=${t.lastPriceCheck} at ${t.lastPriceCheckAt}`)
    console.log(`  closes=${JSON.stringify(t.closes)}`)
    console.log(`  openedAt=${t.openedAt}`)
    console.log(`  positionUnits=${t.positionUnits} feeRT=${t.feesRoundTripPct}`)
    console.log('---')
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
