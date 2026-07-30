import { auth } from "@clerk/nextjs/server";
import {
  deleteCookies,
  looksLikeNetscapeCookies,
  saveEncryptedCookies,
} from "@thumper/pipeline";
import { NextResponse } from "next/server";
import { z } from "zod";

const ProviderSchema = z.enum(["youtube", "soundcloud"]);

export async function PUT(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const provider = ProviderSchema.parse(body.provider);
  const text = String(body.cookies ?? "");
  if (!looksLikeNetscapeCookies(text)) {
    return NextResponse.json(
      { error: "Expected Netscape-format cookies" },
      { status: 400 },
    );
  }

  await saveEncryptedCookies(userId, provider, text);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const provider = ProviderSchema.parse(searchParams.get("provider"));
  await deleteCookies(userId, provider);
  return NextResponse.json({ ok: true });
}
