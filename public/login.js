"use strict";
const $ = (id) => document.getElementById(id);

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("submit").disabled = true;
  $("message").textContent = "";
  try {
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("password").value }) });
    if (response.ok) { location.replace("/"); return; }
    $("message").textContent = (await response.json().catch(() => ({}))).detail || "Could not sign in.";
    $("password").select();
  } catch (_) {
    $("message").textContent = "Could not reach the server.";
  }
  $("submit").disabled = false;
});
