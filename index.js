const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const GRAPHQL_ENDPOINT = 'https://emma.mav.hu//otp2-backend/otp/routers/default/index/graphql';

let cachedTrainData = null;
let cacheTrainTimestamp = 0;
let cachedBusData = null;
let cacheBusTimestamp = 0;
const CACHE_DURATION_MS = 30000;

const TRAIN_POSITIONS_QUERY = `
  query {
    vehiclePositions(swLat: 45.74, swLon: 16.11, neLat: 48.58, neLon: 22.90, modes: [RAIL, RAIL_REPLACEMENT_BUS, SUBURBAN_RAILWAY, TRAMTRAIN]) {
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

function createBusPositionsQuery(swLat, swLon, neLat, neLon) {
  return `
    query {
      vehiclePositions(
        swLat: ${swLat}, 
        swLon: ${swLon}, 
        neLat: ${neLat}, 
        neLon: ${neLon}, 
        modes: [COACH]
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
}

const buildTripQuery = (tripId, serviceDay) => `
  {
    trip(id: "${tripId}", serviceDay: "${serviceDay}") {
      id: gtfsId
      tripGeometry {
        points
      }
      stoptimes {
        arrivalDelay
        departureDelay
        scheduledArrival
        realtimeArrival
        scheduledDeparture
        realtimeDeparture
        stop {
          name
        }
      }
    }
  }
`;

async function graphqlFetch(query) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const result = await response.json();
  if (result.errors) throw new Error(JSON.stringify(result.errors));
  return result.data;
}

function formatTimeFromSeconds(seconds) {
  const date = new Date(seconds * 1000);
  return date.toISOString().substr(11, 5);
}

function getSecondsFromMidnight() {
  const now = new Date();
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}

async function fetchTripDetailsForVehicles(tripIds) {
  const serviceDay = new Date().toISOString().split('T')[0];
  const promises = tripIds.map(async id => {
    const data = await graphqlFetch(buildTripQuery(id, serviceDay));
    return data.trip;
  });
  return Promise.all(promises);
}

async function fetchVehiclePositions(isTrainRequest) {
  let data = {};
  if (isTrainRequest) {
    data = await graphqlFetch(TRAIN_POSITIONS_QUERY);
  } else {
    const rects = [
      { swLat: 45.74, swLon: 16.11, neLat: 47.16, neLon: 19.505 },
      { swLat: 45.74, swLon: 19.505, neLat: 47.16, neLon: 22.9 },
      { swLat: 47.16, swLon: 16.11, neLat: 48.58, neLon: 19.505 },
      { swLat: 47.16, swLon: 19.505, neLat: 48.58, neLon: 22.9 },
    ];

    const allData = await Promise.all(
      rects.map(({ swLat, swLon, neLat, neLon }) => graphqlFetch(createBusPositionsQuery(swLat, swLon, neLat, neLon)))
    );

    const vehiclePositions = allData.flatMap(result => result.vehiclePositions);
    data.vehiclePositions = vehiclePositions;
  }

  const positions = data.vehiclePositions || [];

  const tripIds = positions.map(p => p.trip?.gtfsId || p.trip?.tripId || p.trip?.id).filter(Boolean);

  const tripDetails = await fetchTripDetailsForVehicles(tripIds);

  tripDetails.forEach(trip => {
    positions.forEach(position => {
      if (position.trip?.gtfsId === trip.id) {
        const stoptimes = trip.stoptimes;
        const lastStop = stoptimes[stoptimes.length - 1];
        const delayInMinutes = Math.max(lastStop?.arrivalDelay, lastStop?.departureDelay) / 60;

        const timetable = stoptimes.map(s => ({
          place: s.stop.name,
          expectedArrival: formatTimeFromSeconds(s.scheduledArrival),
          realArrival: formatTimeFromSeconds(s.realtimeArrival),
          expectedDeparture: formatTimeFromSeconds(s.scheduledDeparture),
          realDeparture: formatTimeFromSeconds(s.realtimeDeparture),
        }));

        Object.assign(position, {
          delay: delayInMinutes,
          route: trip.tripGeometry.points,
          start: stoptimes[0]?.stop.name,
          timetable,
        });

        delete position.vehicleId;
        delete position.trip.gtfsId;
        if (trip.stoptimes[trip.stoptimes.length - 1].realtimeDeparture - getSecondsFromMidnight() <= -60 * 5) {
          position.notRelevant = true;
        }
      }
    });
  });

  const positionsFiltered = positions.filter(p => !p.notRelevant);
  return positionsFiltered;
}

app.get('/fetch-train-data', async (req, res) => {
  const now = Date.now();

  if (cachedTrainData && now - cacheTrainTimestamp < CACHE_DURATION_MS) {
    return res.json(cachedTrainData);
  }

  try {
    const data = await fetchVehiclePositions(true);
    cachedTrainData = data;
    cacheTrainTimestamp = now;
    res.json(data);
  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

app.get('/fetch-bus-data', async (req, res) => {
  const now = Date.now();

  if (cachedBusData && now - cacheBusTimestamp < CACHE_DURATION_MS) {
    return res.json(cachedBusData);
  }

  try {
    const data = await fetchVehiclePositions(false);
    cachedBusData = data;
    cacheBusTimestamp = now;
    res.json(data);
  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
