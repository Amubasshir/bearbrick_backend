/**
 * Daily snapshot (like Laravel pricing:snapshot) - 11:07 PM EST via cron
 * Run: node src/scripts/snapshot.js
 */
require("dotenv").config();
const prisma = require("../lib/prisma");

async function main() {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const bricks = await prisma.brickPriceState.findMany();
    for (const brick of bricks) {
        let closePrice = Number(brick.livePrice);
        if (closePrice === null || closePrice === 0) {
            const last = await prisma.brickPriceHistory.findFirst({
                where: { brickId: brick.brickId },
                orderBy: { date: "desc" },
            });
            closePrice = last ? Number(last.closePrice) : 0;
        }
        const votesToday = await prisma.voteEvent.count({
            where: {
                brickId: brick.brickId,
                createdAt: { gte: today, lt: tomorrow },
            },
        });
        await prisma.brickPriceHistory.upsert({
            where: {
                brickId_date: { brickId: brick.brickId, date: today },
            },
            update: { closePrice, votesThatDay: votesToday },
            create: {
                brickId: brick.brickId,
                date: today,
                closePrice,
                votesThatDay: votesToday,
            },
        });
    }
    console.log("Daily snapshot created for", bricks.length, "bricks.");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
