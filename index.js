const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());

let cachedData = null;
let cacheTimestamp = 0;
const CACHE_DURATION_MS = 20 * 1000;

const VEHICLE_POSITIONS_QUERY = `
  query {
    vehiclePositions(
      swLat: 45.74,
      swLon: 16.11,
      neLat: 48.58,
      neLon: 22.90,
      modes: [RAIL, RAIL_REPLACEMENT_BUS, SUBURBAN_RAILWAY, TRAMTRAIN]
    ) {
      vehicleId
      lat
      lon
      speed
      heading
      trip {
      gtfsId
        tripHeadsign
        tripShortName
      }
    }
  }
`;

function getAxiosOptions(query) {
  return {
    method: 'POST',
    url: 'https://emma.mav.hu//otp2-backend/otp/routers/default/index/graphql',
    headers: {
      'Content-Type': 'application/json',
    },
    data: {
      query,
      variables: {},
    },
    decompress: true,
  };
}

function formatTimeFromSeconds(secondsSinceMidnight) {
  const date = new Date(secondsSinceMidnight * 1000);
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

function buildTripQuery(tripId) {
  const serviceDay = new Date().toISOString().split('T')[0];
  return {
    query: `
        {
          trip(id: "${tripId}", serviceDay: "${serviceDay}") {
            id: gtfsId
            tripGeometry{
              points
            }
            stoptimes {
            arrivalDelay
            departureDelay
            scheduledArrival
            realtimeArrival
            scheduledDeparture
            realtimeDeparture
            stop{
              name
            }
          }
          }
        }
      `,
    variables: {},
  };
}

async function fetchTripDetailsForVehicles(vehicles) {
  const tripQueries = vehicles.map(id => {
    const data = buildTripQuery(id);
    return axios.post('https://emma.mav.hu//otp2-backend/otp/routers/default/index/graphql', data, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  });

  const responses = await Promise.all(tripQueries.filter(Boolean));
  return responses.map(r => r.data.data);
}

async function fetchVehiclePositions() {
  const options = getAxiosOptions(VEHICLE_POSITIONS_QUERY);
  const response = await axios(options);
  const positions = response.data.data.vehiclePositions || [];

  const tripIds = positions.map(p => p.trip?.gtfsId || p.trip?.tripId || p.trip?.id).filter(Boolean);
  const tripDetails = await fetchTripDetailsForVehicles(tripIds);
  tripDetails.forEach(trip => {
    positions.forEach(position => {
      if (position.trip.gtfsId == trip.trip.id) {
        const stoptimes = trip.trip.stoptimes;
        const delay = stoptimes[stoptimes.length - 1];
        const delayInMinutes = Math.max(delay?.arrivalDelay, delay?.departureDelay) / 60;
        const timetable = [];
        stoptimes.forEach(stoptime => {
          let stop = {};
          stop.place = stoptime.stop.name;
          stop.expectedArrival = formatTimeFromSeconds(stoptime.scheduledArrival);
          stop.realArrival = formatTimeFromSeconds(stoptime.realtimeArrival);
          stop.expectedDeparture = formatTimeFromSeconds(stoptime.scheduledDeparture);
          stop.realDeparture = formatTimeFromSeconds(stoptime.realtimeDeparture);
          timetable.push(stop);
        });
        position.delay = delayInMinutes;
        position.route = trip.trip.tripGeometry.points;
        position.start = trip.trip.stoptimes[0].stop.name;
        position.timetable = timetable;
      }
    });
  });
  return positions;
}

app.get('/fetch-data', async (req, res) => {
  const now = Date.now();
  if (cachedData && now - cacheTimestamp < CACHE_DURATION_MS) {
    return res.json(cachedData);
  }

  try {
    const data = await fetchVehiclePositions();
    cachedData = data;
    cacheTimestamp = now;
    res.json(data);
  } catch (error) {
    console.error('Error fetching data:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
