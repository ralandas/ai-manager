import { BnovoClient } from './src/pms/bnovo.js';

async function test() {
  const bnovo = new BnovoClient({
    username: 'progon@sutkispb.ru',
    password: 'progonprogon',
  });
  console.log("Testing Bnovo calendar fetch for August 2026...");
  try {
    const today = '2026-08-01';
    const nextMonth = '2026-08-31';
    // Let's inspect raw bookings from bnovo fetchBookings
    // @ts-ignore
    const { result, closures } = await bnovo.fetchBookings(today, nextMonth);
    console.log("Bookings count in August:", result.length);
    console.log("Closures count in August:", closures.length);
    if (result.length > 0) {
      console.log("Sample booking:", {
        id: result[0].booking_id,
        room_id: result[0].room_id,
        name: result[0].name,
        surname: result[0].surname,
        arrival: result[0].real_arrival,
        departure: result[0].real_departure,
        amount: result[0].amount
      });
    }

    // Also test photos for a property
    const props = await bnovo.listProperties();
    const photos = await bnovo.getPhotos(props[0].id);
    console.log("Photos for property", props[0].title, ":", photos.length, "photos found");
    console.log("First photo:", photos[0]);
  } catch (e) {
    console.error("Calendar test error:", e);
  }
}
test();
