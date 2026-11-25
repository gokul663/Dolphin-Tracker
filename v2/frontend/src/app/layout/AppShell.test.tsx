import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { AppShell } from "@/app/layout/AppShell";
import { makeMe, mockApi, renderWithProviders } from "@/test/render";
import { keys } from "@/lib/api/keys";

const auth = vi.hoisted(() => ({ signOut: vi.fn(async () => {}), profilePicture: vi.fn(async () => "") }));
vi.mock("@/lib/auth/token", async (original) => ({ ...(await original<typeof import("@/lib/auth/token")>()), ...auth }));

function renderShell(me = makeMe("admin")) {
  mockApi({ "GET /api/health": () => ({ status: "ok", env: "test", db: true, ts: "" }) });
  const view = renderWithProviders(
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<p>home</p>} />
      </Route>
    </Routes>,
    { path: "/*" },
  );
  view.client.setQueryData(keys.me, me);
  return view;
}

describe("AppShell: who is signed in", () => {
  it("shows the Google photo as the account button; name, email, role and Sign out are behind it", async () => {
    auth.profilePicture.mockResolvedValue("https://lh3.googleusercontent.com/a/photo");
    renderShell({ ...makeMe("admin"), id: "u1", name: "Dana Admin", email: "dana@example.com" });
    const button = await screen.findByRole("button", { name: "Account: Dana Admin" });
    expect((await within(button).findByRole("img")).getAttribute("src")).toBe("https://lh3.googleusercontent.com/a/photo");
    expect(screen.queryByText("dana@example.com")).toBeNull(); // behind the photo
    await userEvent.click(button);
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("Dana Admin");
    expect(menu.textContent).toContain("dana@example.com");
    expect(menu.textContent).toContain("Tracker Admin");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Sign out" }));
    expect(auth.signOut).toHaveBeenCalled();
  });

  it("falls back to initials when the sign-in has no photo", async () => {
    auth.profilePicture.mockResolvedValue("");
    renderShell({ ...makeMe("viewer"), id: "u2", name: "Sam Lee", email: "sam@example.com" });
    const button = await screen.findByRole("button", { name: "Account: Sam Lee" });
    expect(button.textContent).toBe("SL");
    expect(within(button).queryByRole("img")).toBeNull();
  });
});
