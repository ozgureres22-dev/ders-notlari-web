"use strict";
const $ = (id) => document.getElementById(id);

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("submit").disabled = true;
  $("message").textContent = "";
  const send = () => fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("password").value }) });
  try {
    // Telefonda ağ kısa süre koparsa bir kez daha denenir.
    const response = await send().catch(() => new Promise((resolve) => setTimeout(resolve, 1500)).then(send));
    if (response.ok) { location.replace("/"); return; }
    $("message").textContent = (await response.json().catch(() => ({}))).detail || "Could not sign in.";
    $("password").select();
  } catch (_) {
    $("message").textContent = "No connection to the site. Check your internet and try again.";
  }
  $("submit").disabled = false;
});
