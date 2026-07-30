import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "70vh" }}>
      <SignIn />
    </div>
  );
}
