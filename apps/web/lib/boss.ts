import { PgBoss } from "pg-boss";

let bossPromise: Promise<PgBoss> | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    bossPromise = (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL is required");
      const boss = new PgBoss(url);
      await boss.start();
      return boss;
    })();
  }
  return bossPromise;
}
