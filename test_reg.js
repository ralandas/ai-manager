async function test() {
  const res = await fetch("http://178.88.115.213/api/v2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "user_test_" + Date.now() + "@progon.pro",
      password: "password123",
      name: "Rauan"
    })
  });
  console.log("Status:", res.status);
  const data = await res.json();
  console.log("Response:", data);
}
test();
