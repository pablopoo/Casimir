<script>
import ThemeToggle from "../_ThemeToggle.vue" with { island: "load" }

document.getElementById("mixed-target").textContent = "hydrated (success)"
</script>

---

title: Mixed Test
description: Tests island imports coexisting with client script

---

<ThemeToggle />

<span id="mixed-target">pending</span>
