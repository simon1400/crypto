import { PrismaClient } from '@prisma/client'

const basePrisma = new PrismaClient()

export const prisma = basePrisma.$extends({
  query: {
    trade: {
      async update({ args, query }) {
        if (args.data?.status === 'CANCELLED') {
          const id = args.where?.id
          console.log(`[DB DEBUG] Trade.update #${id} → CANCELLED | stack=${new Error().stack?.split('\n').slice(2, 5).join(' → ')}`)
        }
        return query(args)
      },
      async updateMany({ args, query }) {
        if ((args.data as any)?.status === 'CANCELLED') {
          console.log(`[DB DEBUG] Trade.updateMany → CANCELLED | where=${JSON.stringify(args.where)} | stack=${new Error().stack?.split('\n').slice(2, 5).join(' → ')}`)
        }
        return query(args)
      },
    },
  },
}) as unknown as PrismaClient
