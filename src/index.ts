import 'dotenv/config';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import fetch from 'node-fetch';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { MongoClient, Collection } from 'mongodb';

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || '';
let remindersCollection: Collection;
let eventsCollection: Collection;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('smart-reminders');
  remindersCollection = db.collection('reminders');
  eventsCollection = db.collection('events');
  console.log('Connected to MongoDB!');
}

// type definitions after imports
interface WeatherResponse {
  main: {
    temp: number;
    feels_like: number;
    humidity: number;
    pressure: number;
  };
  weather: Array<{
    main: string;
    description: string;
  }>;
  wind: {
    speed: number;
  };
  visibility: number;
  name: string;
  sys: {
    country: string;
  };
}

interface LocationResponse {
  city: string;
  region: string;
  country: string;
  loc: string;
  postal: string;
  timezone: string;
}

interface GeocodeResponse {
  lat: string;
  lon: string;
}[];

// === SMART REMINDER INTERFACES AND STORAGE ===
interface SmartReminder {
  id: number;
  message: string;
  triggerType: "time" | "location" | "weather" | "combination";
  conditions: {
    time?: string;
    location?: string;
    radius?: number;
    weather?: string;
  };
  createdAt: string;
  triggered: boolean;
}

const REMINDERS_FILE = 'C:/Users/popal/Smart Reminder App Development/01-mcp-prototype/reminders.json';

async function loadReminders(): Promise<SmartReminder[]> {
  const reminders = await remindersCollection.find({}).toArray();
  return reminders.map((r: any) => ({
    id: r.id,
    message: r.message,
    triggerType: r.triggerType,
    conditions: r.conditions,
    createdAt: r.createdAt,
    triggered: r.triggered
  }));
}

async function saveReminder(reminder: SmartReminder): Promise<void> {
  await remindersCollection.insertOne(reminder);
}

async function deleteReminderById(id: number): Promise<void> {
  await remindersCollection.deleteOne({ id });
}

// === CONSTANTS & HELPERS FOR NEARBY PLACES ===
const NOMINATIM_USER_AGENT = 'SmartReminderApp/1.0 (Ogpro01@gmail.com)'; // replace with a real email

// Simple in-memory cache for places
const placesCache = new Map<string, { timestamp: number; data: any }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function getCacheKey(location: string, placeType: string, radius: number) {
  return `${location}|${placeType}|${radius}`;
}

// Haversine formula to calculate distance in meters
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3; // metres
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lon2-lon1) * Math.PI/180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c; // in metres
}

// Helper to format places list for display
function formatPlaces(places: any[], locationName: string, isMock: boolean, radiusKm: number, keyword?: string): string {
  let header = isMock
    ? `🔍 **Sample ${places[0]?.type || 'places'} near ${locationName}** (Demo Data)`
    : `🗺️ **Found ${places.length} ${places[0]?.type || 'places'} near ${locationName}**`;

  if (keyword && !isMock) {
    header += ` matching "${keyword}"`;
  }
  // ... change made here

  const placeLines = places.map((p, idx) => {
    const cuisineInfo = p.cuisine ? ` • ${p.cuisine}` : '';
    return `${idx + 1}. **${p.name}**\n   📍 ${p.address}\n   📏 ${(p.distance * 0.000621371).toFixed(1)} mi away${cuisineInfo}`;
  }).join('\n\n');

  return `${header}\n\n${placeLines}\n\n*Powered by OpenStreetMap • Radius: ${(radiusKm * 0.621371).toFixed(1)} mi*`;
}

// Generate simple mock places when real data fails
function generateMockPlaces(placeType: string, radius: number): any[] {
  const names: Record<string, string[]> = {
    restaurant: ['Pizza Place', 'Burger Spot', 'Sushi House', 'Taco Stand', 'Pasta Bar'],
    cafe: ['Coffee House', 'Tea Room', 'Espresso Bar', 'Bakery Cafe', 'Internet Cafe'],
    hotel: ['Grand Hotel', 'City Inn', 'Suites Downtown', 'Airport Hotel', 'Budget Stay'],
    attraction: ['City Museum', 'Art Gallery', 'Historic Monument', 'Park', 'Zoo'],
    pharmacy: ['Health Pharmacy', 'Drugstore', 'Medical Supply', 'Corner Pharmacy'],
    gas_station: ['Gas & Go', 'Fuel Stop', 'Service Station', 'Express Gas']
  };

  const typeNames = names[placeType] || ['Sample Place'];
  const count = 3; // generate 3 mock places

  return Array.from({ length: count }, (_, i) => ({
    name: typeNames[i % typeNames.length] + (i > 0 ? ` ${i+1}` : ''),
    address: `${100 + i*50} Main St`,
    distance: 500 + i * 800, // increasing distances
    type: placeType,
    cuisine: placeType === 'restaurant' ? ['Italian', 'American', 'Japanese'][i] : undefined,
    radius: radius / 1000
  }));
}

// Reverse geocode cache (separate from places cache)
const reverseCache = new Map<string, { timestamp: number; address: string }>();
const REVERSE_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days (addresses rarely change)

async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const key = `${lat},${lon}`;
  const cached = reverseCache.get(key);
  if (cached && Date.now() - cached.timestamp < REVERSE_CACHE_TTL) {
    return cached.address;
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const response = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_USER_AGENT }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as any;
    const address = data.display_name || null;
    if (address) {
      reverseCache.set(key, { timestamp: Date.now(), address });
    }
    return address;
  } catch (error) {
    console.error('Reverse geocode failed:', error);
    return null;
  }
}

function convertTo24Hour(timeStr: string): string {
  // If already in 24-hour format like "14:30", return as-is
  if (/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(timeStr)) {
    return timeStr;
  }
  
  // Convert "2:30 PM" or "02:30 PM" to "14:30"
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return timeStr; // if no match, return original
  
  let hours = parseInt(match[1]);
  const minutes = match[2];
  const period = match[3].toUpperCase();
  
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  
  return `${hours.toString().padStart(2, '0')}:${minutes}`;
}

function evaluateWeatherCondition(conditionStr: string, currentWeather: string | null, currentTempF: number | null): boolean {
  if (!currentWeather && currentTempF === null) return false;

  // Check for temperature pattern: temp>75, temp<32, temp>=70, temp<=32, temp=70
  const tempMatch = conditionStr.match(/temp\s*([><=]+)\s*(\d+)/i);
  if (tempMatch) {
    const operator = tempMatch[1];
    const targetTemp = parseInt(tempMatch[2]);
    if (currentTempF === null) return false;
    switch (operator) {
      case '>': return currentTempF > targetTemp;
      case '<': return currentTempF < targetTemp;
      case '>=': return currentTempF >= targetTemp;
      case '<=': return currentTempF <= targetTemp;
      case '=': return currentTempF === targetTemp;
      default: return false;
    }
  }
  
  // Otherwise, treat as weather condition keyword
  if (!currentWeather) return false;
  return currentWeather.includes(conditionStr.toLowerCase());
}

// Parse command line arguments to determine transport type
const useSSE = process.argv.includes("--sse");

// Initialize server
const server = new McpServer({
  name: "hello-world",
  version: "1.0.0"
});

// === RESOURCES ===

// Define a simple hello world resource
server.resource(
  "hello-world",
  "hello://world",
  async (uri) => ({
    contents: [{
      uri: uri.href,
      text: "Hello, World! This is my first MCP resource."
    }]
  })
);

// === TOOLS ===

// Define the event interface
interface CalendarEvent {
  id: number;
  title: string;
  date: string;
  time: string;
  duration: number;
}

// Use ABSOLUTE path for shared storage between MCP Inspector and Claude
const EVENTS_FILE = 'C:/Users/popal/Smart Reminder App Development/01-mcp-prototype/calendar-events.json';

// Load events from file or use defaults
async function loadEvents(): Promise<any[]> {
  const events = await eventsCollection.find({}).toArray();
  return events.map((e: any) => ({
    id: e.id,
    title: e.title,
    date: e.date,
    time: e.time,
    duration: e.duration,
    createdAt: e.createdAt
  }));
}

async function saveEvent(event: any): Promise<void> {
  await eventsCollection.insertOne(event);
}

async function deleteEventById(id: number): Promise<void> {
  await eventsCollection.deleteOne({ id });
}

// Define a calendar tool for managing events
server.tool(
  "calendar",
  "Manage calendar events - create, list, check availability, and delete events",
  {
    action: z.enum(["create_event", "list_events", "check_availability", "delete_event"], {
      description: "The calendar action to perform"
    }),
    title: z.string().optional(),
    date: z.string().optional(),
    time: z.string().optional(),
    duration: z.number().optional()
  },
  async ({ action, title, date, time, duration }) => {
    
    // Load events from persistent storage
    let events = await loadEvents();
    
    // Helper function to convert 12-hour time to 24-hour for calculations
    function convertTo24Hour(time12h: string) {
      const [time, modifier] = time12h.split(' ');
      let [hours, minutes] = time.split(':');
      
      if (modifier === 'PM' && hours !== '12') {
        hours = String(parseInt(hours, 10) + 12);
      }
      if (modifier === 'AM' && hours === '12') {
        hours = '00';
      }
      
      return `${hours.padStart(2, '0')}:${minutes}`;
    }
    
    // Helper function to parse MM-DD-YYYY date
    function parseDate(dateStr: string) {
      const [month, day, year] = dateStr.split('-').map(Number);
      return new Date(year, month - 1, day);
    }

    switch (action) {
      case "create_event":
        if (!title || !date || !time || !duration) {
          throw new Error("Missing required fields for creating event");
        }
        
        // Validate time format (should contain AM/PM)
        if (!time.includes('AM') && !time.includes('PM')) {
          throw new Error("Please specify time with AM or PM (e.g., '2:30 PM')");
        }
        
        const newEvent: CalendarEvent = {
          id: events.length + 1,
          title,
          date,
          time,
          duration
        };
        events.push(newEvent);
        // removed - using MongoDB now
        
        return {
          content: [{
            type: "text",
            text: `✅ Event created: "${title}" on ${date} at ${time} for ${duration} minutes`
          }]
        };
        
      case "list_events":
        if (events.length === 0) {
          return {
            content: [{
              type: "text", 
              text: "No events scheduled yet. Use 'create_event' to add events."
            }]
          };
        }
        const eventList = events.map((event: CalendarEvent) => 
          `• ${event.title} - ${event.date} at ${event.time} (${event.duration}min)`
        ).join('\n');
        return {
          content: [{
            type: "text",
            text: `📅 Your scheduled events:\n${eventList}`
          }]
        };
        
      case "check_availability":
        if (!date || !time || !duration) {
          throw new Error("Missing date, time, or duration for availability check");
        }
        
        // Validate time format
        if (!time.includes('AM') && !time.includes('PM')) {
          throw new Error("Please specify time with AM or PM (e.g., '2:30 PM')");
        }
        
        // Convert to 24-hour format for comparison
        const time24h = convertTo24Hour(time);
        const requestedDateTime = new Date(parseDate(date).setHours(
          parseInt(time24h.split(':')[0]),
          parseInt(time24h.split(':')[1])
        ));
        
        const endTime = new Date(requestedDateTime.getTime() + duration * 60000);
        
        const hasConflict = events.some((event: CalendarEvent) => {
          const eventTime24h = convertTo24Hour(event.time);
          const eventDate = parseDate(event.date);
          const eventStart = new Date(eventDate.setHours(
            parseInt(eventTime24h.split(':')[0]),
            parseInt(eventTime24h.split(':')[1])
          ));
          const eventEnd = new Date(eventStart.getTime() + event.duration * 60000);
          
          return requestedDateTime < eventEnd && endTime > eventStart;
        });
        
        if (hasConflict) {
          return {
            content: [{
              type: "text",
              text: `❌ Time slot not available on ${date} at ${time}. There's a scheduling conflict.`
            }]
          };
        } else {
          return {
            content: [{
              type: "text", 
              text: `✅ Time slot available on ${date} at ${time} for ${duration} minutes`
            }]
          };
        }

      case "delete_event":
        if (!title) {
          throw new Error("Missing event title for deletion");
        }
        
        const initialLength = events.length;
        events = events.filter(event => event.title !== title);
        
        if (events.length === initialLength) {
          return {
            content: [{
              type: "text",
              text: `❌ No event found with title "${title}"`
            }]
          };
        }
        
        // removed - using MongoDB now
        return {
          content: [{
            type: "text", 
            text: `✅ Event "${title}" deleted successfully`
          }]
        };
        
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }
);

// Weather tool - get current weather using OpenWeatherMap API
server.tool(
  "weather",
  "Get current weather forecasts for any city worldwide",
  {
    city: z.string({
      description: "The city name to get weather for (e.g., 'New York', 'London', 'Tokyo')"
    })
  },
  async ({ city }) => {
    try {
      // OpenWeatherMap API key
      const API_KEY = "650f3d5e31298d698584354067714c54";
      
      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${API_KEY}&units=metric`
      );
      
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Invalid API key - please check your OpenWeatherMap API key");
        }
        if (response.status === 404) {
          throw new Error(`City "${city}" not found. Try a different spelling or larger city.`);
        }
        throw new Error(`Weather service unavailable: ${response.statusText}`);
      }
      
      const data = await response.json() as WeatherResponse;
      
      // Convert temperature to both Celsius and Fahrenheit
      const tempC = Math.round((data as any).main.temp);
      const tempF = Math.round((tempC * 9/5) + 32);
      const feelsLikeC = Math.round(data.main.feels_like);
      const feelsLikeF = Math.round((feelsLikeC * 9/5) + 32);
      
      // Weather emoji based on condition
      const getWeatherEmoji = (main: string) => {
        const emojis: {[key: string]: string} = {
          'Clear': '☀️',
          'Clouds': '☁️',
          'Rain': '🌧️',
          'Drizzle': '🌦️',
          'Thunderstorm': '⛈️',
          'Snow': '❄️',
          'Mist': '🌫️',
          'Fog': '🌫️'
        };
        return emojis[main] || '🌤️';
      };
      
      const weatherEmoji = getWeatherEmoji(data.weather[0].main);
      const condition = data.weather[0].description.charAt(0).toUpperCase() + data.weather[0].description.slice(1);
      
      const weatherInfo = `
${weatherEmoji} **Weather in ${data.name}, ${data.sys.country}**
• **Temperature**: ${tempC}°C (${tempF}°F)
• **Feels like**: ${feelsLikeC}°C (${feelsLikeF}°F)
• **Condition**: ${condition}
• **Humidity**: ${data.main.humidity}%
• **Wind**: ${data.wind.speed} m/s
• **Pressure**: ${data.main.pressure} hPa
• **Visibility**: ${(data.visibility / 1000).toFixed(1)} km
      `.trim();
      
      return {
        content: [{
          type: "text",
          text: weatherInfo
        }]
      };
    } catch (error) {
      // Fallback to mock data if API fails
      const mockWeather = {
        "new york": `🌤️ **Weather in New York, USA** (Live Data Unavailable)
• **Temperature**: 15°C (59°F)
• **Feels like**: 14°C (57°F)
• **Condition**: Partly Cloudy
• **Humidity**: 65%
• **Wind**: 12 kph (7 mph) NW
• **Pressure**: 1013 hPa
• **Visibility**: 16 km`,

        "london": `🌧️ **Weather in London, UK** (Live Data Unavailable)
• **Temperature**: 8°C (46°F)
• **Feels like**: 6°C (43°F)
• **Condition**: Light Rain
• **Humidity**: 85%
• **Wind**: 18 kph (11 mph) SW
• **Pressure**: 1005 hPa
• **Visibility**: 10 km`,

        "tokyo": `☀️ **Weather in Tokyo, Japan** (Live Data Unavailable)
• **Temperature**: 22°C (72°F)
• **Feels like**: 23°C (73°F)
• **Condition**: Sunny
• **Humidity**: 45%
• **Wind**: 8 kph (5 mph) NE
• **Pressure**: 1015 hPa
• **Visibility**: 20 km`,

        "sydney": `⛅ **Weather in Sydney, Australia** (Live Data Unavailable)
• **Temperature**: 25°C (77°F)
• **Feels like**: 26°C (79°F)
• **Condition**: Mostly Sunny
• **Humidity**: 60%
• **Wind**: 15 kph (9 mph) SE
• **Pressure**: 1012 hPa
• **Visibility**: 18 km`
      };

      const normalizedCity = city.toLowerCase().trim();
      const mockData = mockWeather[normalizedCity as keyof typeof mockWeather];
      
      if (mockData) {
        return {
          content: [{
            type: "text",
            text: mockData + `\n\n*Note: Using demo data due to API error.*`
          }]
        };
      } else {
        return {
          content: [{
            type: "text",
            text: `❌ Could not fetch weather for "${city}". Try: New York, London, Tokyo, or Sydney.\nError: ${error instanceof Error ? error.message : 'Unknown error'}`
          }]
        };
      }
    }
  }
);

// === LOCATION FINDER TOOLS ===

// Tool 1: Get User's Current Location via IP
server.tool(
  "get_current_location",
  "Get your approximate current location based on IP address",
  {},
  async () => {
    try {
      // Using free ipinfo.io API (no key needed, 50k requests/month free)
      const response = await fetch('https://ipinfo.io/json');
      
      if (!response.ok) {
        throw new Error('Location service unavailable');
      }
      
      const data = await response.json() as LocationResponse;
      
      const locationInfo = `
📍 **Your Current Location (Approximate)**
• **City**: ${(data as any).city}
• **Region**: ${data.region}
• **Country**: ${data.country}
• **Coordinates**: ${data.loc}
• **Postal Code**: ${data.postal}
• **Timezone**: ${data.timezone}

*Note: This is based on your IP address. Accuracy: City-level (~1-6 miles)*
      `.trim();
      
      return {
        content: [{
          type: "text",
          text: locationInfo
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Could not determine your location. Error: ${error instanceof Error ? error.message : 'Unknown'}`
        }]
      };
    }
  }
);

// Tool 2: Find Nearby Places (Restaurants, Cafes, etc.)
server.tool(
  "find_nearby_places",
  "Find restaurants, cafes, hotels, and other places near a location using Google Places",
  {
    place_type: z.enum(["restaurant", "cafe", "hotel", "attraction", "pharmacy", "gas_station"]),
    location: z.string().optional(),
    radius: z.number().optional().default(5000),
    keyword: z.string().optional().describe("Search term (e.g., 'chinese', 'burgers')"),
    min_rating: z.number().min(0).max(5).optional().describe("Minimum star rating (e.g., 4.0)")
  },
  async ({ place_type, location, radius, keyword, min_rating }) => {
    const debugFile = 'debug.log';
    const appendDebug = (msg: string) => {
      writeFileSync(debugFile, msg + '\n', { flag: 'a' });
    };

    try {
      appendDebug(`Current working directory: ${process.cwd()}`);
      appendDebug('=== find_nearby_places called ===');
      appendDebug(`place_type=${place_type}, location=${location}, radius=${radius}, keyword=${keyword}`);

      // 1. Get coordinates for the location
      let lat: number, lon: number, displayName: string;
      const googleApiKey = process.env.GOOGLE_PLACES_API_KEY;
      appendDebug(`API key present: ${!!googleApiKey}`);
      if (!googleApiKey) throw new Error("Google Places API key not configured");

      if (!location) {
        // Use IP location (fallback)
        appendDebug('No location provided, using IP');
        const ipRes = await fetch('https://ipinfo.io/json');
        const ipData = await ipRes.json() as any;
        const [latStr, lonStr] = ipData.loc.split(',');
        lat = parseFloat(latStr);
        lon = parseFloat(lonStr);
        displayName = `${ipData.city}, ${ipData.region}`;
      } else {
        // Geocode the location using Google Geocoding API
        appendDebug(`Geocoding location: ${location}`);
        const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${googleApiKey}`;
        const geoRes = await fetch(geoUrl);
        const geoData = await geoRes.json() as any;
        appendDebug(`Geocode status: ${geoData.status}`);
        if (geoData.status !== 'OK' || !geoData.results.length) {
          throw new Error(`Location "${location}" not found`);
        }
        lat = geoData.results[0].geometry.location.lat;
        lon = geoData.results[0].geometry.location.lng;
        displayName = geoData.results[0].formatted_address;
        appendDebug(`Coordinates: ${lat}, ${lon}`);
      }

      // 2. Build Google Places API request
      const typeMap: Record<string, string> = {
        restaurant: 'restaurant',
        cafe: 'cafe',
        hotel: 'lodging',
        attraction: 'tourist_attraction',
        pharmacy: 'pharmacy',
        gas_station: 'gas_station'
      };
      const googleType = typeMap[place_type] || place_type;
      let placesUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lon}&radius=${radius}&type=${googleType}&key=${googleApiKey}`;
      if (keyword && keyword.trim() !== '') {
        placesUrl += `&keyword=${encodeURIComponent(keyword)}`;
      }
      appendDebug(`Places URL: ${placesUrl.replace(googleApiKey, 'HIDDEN')}`);

      const placesRes = await fetch(placesUrl);
      const placesData = await placesRes.json() as any;
      appendDebug(`Places API status: ${placesData.status}`);

      if (placesData.status !== 'OK' && placesData.status !== 'ZERO_RESULTS') {
        throw new Error(`Google Places error: ${placesData.status}`);
      }

      if (!placesData.results || placesData.results.length === 0) {
        appendDebug('No results from Places API');
        return {
          content: [{
            type: "text",
            text: `No ${place_type}s found near ${displayName}${keyword ? ` matching "${keyword}"` : ''}.`
          }]
        };
      }

      // 3. Process and format the results (limit to 10)
      // Map all results (no slice yet)
      let places = placesData.results.map((place: any) => {
  	const distance = haversineDistance(lat, lon, place.geometry.location.lat, place.geometry.location.lng);
  	return {
    	  name: place.name,
    	  address: place.vicinity || 'Address not available',
    	  distance: distance,
    	  rating: place.rating ? `⭐ ${place.rating}` : null,
    	  ratingValue: place.rating || 0,   // numeric rating for sorting
    	  openNow: place.opening_hours?.open_now ? 'Open now' : null
  	};
      });

      // Apply rating filter if min_rating provided
      if (min_rating !== undefined && min_rating > 0) {
        places = places.filter((p: any) => p.ratingValue >= min_rating);
      }

      // Sort: higher rating first, then closer distance
      places.sort((a: any, b: any) => {
  	if (a.ratingValue !== b.ratingValue) return b.ratingValue - a.ratingValue;
  	return a.distance - b.distance;
      });

      // Take top 10
      places = places.slice(0, 10);

      // 4. Format output
      const lines = places.map((p: any, idx: number) => {
        let line = `${idx+1}. **${p.name}**\n   📍 ${p.address}\n   📏 ${(p.distance * 0.000621371).toFixed(1)} mi away`;
        if (p.rating) line += `\n   ${p.rating}`;
        if (p.openNow) line += ` • ${p.openNow}`;
        return line;
      }).join('\n\n');

      let header = `🗺️ **Found ${places.length} ${place_type}s near ${displayName}**`;
      if (keyword) header += ` matching "${keyword}"`;
      if (min_rating) header += ` with rating ≥ ${min_rating}⭐`;
      header += ` (sorted by highest rating, then closest distance)`;
      const footer = `*Powered by Google Places • Radius: ${(radius/1000 * 0.621371).toFixed(1)} mi*`;

      appendDebug(`Returning ${places.length} results`);
      return {
        content: [{
          type: "text",
          text: `${header}\n\n${lines}\n\n${footer}`
        }]
      };

    } catch (error) {
      appendDebug(`Catch error: ${error instanceof Error ? error.message : String(error)}`);
      // Fallback to mock data
      const mockPlaces = generateMockPlaces(place_type, radius);
      const locationName = location || 'your location';
      const mockFormatted = formatPlaces(mockPlaces, locationName, true, radius / 1000, keyword);
      return {
        content: [{
          type: "text",
          text: mockFormatted + `\n\n(Error: ${error instanceof Error ? error.message : 'Unknown error'})`
        }]
      };
    }
  }
);

//create_smart_reminder Tool
server.tool(
  "create_smart_reminder",
  "Create a reminder that can trigger based on time, location, weather, or any combination",
  {
    message: z.string(),
    triggerType: z.enum(["time", "location", "weather", "combination"]),
    conditions: z.object({
      time: z.string().optional(),
      location: z.string().optional(),
      radius: z.number().optional(),
      weather: z.string().optional().describe("Weather condition or temperature, e.g., 'rain', 'clear', 'temp>75', 'temp<32'")    
    })
  },
  async ({ message, triggerType, conditions }) => {
      // Convert time to 24-hour format if present
           if (conditions.time) {
           conditions.time = convertTo24Hour(conditions.time);
           }

    const reminders = await loadReminders();
    const newId = reminders.length > 0 ? Math.max(...reminders.map(r => r.id)) + 1 : 1;
    const newReminder: SmartReminder = {
      id: newId,
      message,
      triggerType,
      conditions,
      createdAt: new Date().toISOString(),
      triggered: false
    };
    reminders.push(newReminder);
    // removed - using MongoDB now
    return {
      content: [{
        type: "text",
        text: `✅ Smart reminder created (ID: ${newId}): "${message}"\nTrigger: ${triggerType}`
      }]
    };
  }
);


// === PROMPTS ===

// Define a greeting prompt
server.prompt(
  "greeting",
  {
    name: z.string(),
    time_of_day: z.enum(["morning", "afternoon", "evening", "night"])
  },
  ({ name, time_of_day }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Hello ${name}! Good ${time_of_day}. How are you today?`
      }
    }]
  })
);

async function getCurrentWeatherByCity(city: string): Promise<string | null> {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return null;
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`;
    const res = await fetch(url);
    const data = await res.json() as any;
    if (data.weather && data.weather[0]) {
      return data.weather[0].main.toLowerCase(); // "rain", "clear", etc.
    }
    return null;
  } catch {
    return null;
  }
}

// check_reminders Tool 
server.tool(
  "check_reminders",
  "Check which smart reminders are due based on current time, location, and weather",
  {},
  async () => {
    const reminders = await loadReminders();
    const dueReminders: SmartReminder[] = [];

    // ---- Get current context ----
    const now = new Date();
    const currentHourMin = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;

    // Get current city from IP
    let currentCity = "Unknown";
    try {
      const ipRes = await fetch('https://ipinfo.io/json');
      const ipData = await ipRes.json() as any;
      currentCity = ipData.city || "Unknown";
    } catch (error) {
      console.error("Failed to get location", error);
    }

    // Get current weather condition (simplified)
    let currentWeather: string | null = null;
    let currentTempF: number | null = null;
    if (currentCity !== "Unknown") {
      const apiKey = process.env.OPENWEATHER_API_KEY;
      if (apiKey) {
        try {
          const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(currentCity)}&appid=${apiKey}&units=metric`;
          const res = await fetch(url);
          const data = await res.json() as any;
          if (data.weather && data.weather[0]) {
                             currentWeather = data.weather[0].main.toLowerCase(); // e.g., "rain"
                             // Get temperature in Fahrenheit
                             const tempC = data.main.temp;
                             currentTempF = Math.round(tempC * 9/5 + 32); // store as number
                           }
        } catch (e) {
          console.error("Weather fetch failed", e);
        }
      }
    }

    // ---- Evaluate each reminder ----
    for (const rem of reminders) {
      if (rem.triggered) continue;

      let due = false;
      const cond = rem.conditions;

      switch (rem.triggerType) {
        case "time":
          if (cond.time) {
            const reminderTime = convertTo24Hour(cond.time);
            due = currentHourMin >= reminderTime;
          }
          break;

        case "location":
          if (cond.location && currentCity !== "Unknown") {
            due = currentCity.toLowerCase().includes(cond.location.toLowerCase());
          }
          break;

        case "weather":
          if (cond.weather) {
                             due = evaluateWeatherCondition(cond.weather, currentWeather, currentTempF);
	  }
          break;

        case "combination":
          let timeOk = true, locOk = true, weatherOk = true;
          if (cond.time) {
            const reminderTime = convertTo24Hour(cond.time);
            timeOk = currentHourMin >= reminderTime;
          }
          if (cond.location && currentCity !== "Unknown") {
            locOk = currentCity.toLowerCase().includes(cond.location.toLowerCase());
          }
          if (cond.weather) {
                             weatherOk = evaluateWeatherCondition(cond.weather, currentWeather, currentTempF);
                         }
          due = timeOk && locOk && weatherOk;
          break;
      }

      if (due) {
        dueReminders.push(rem);
        // Optional: mark as triggered to prevent re-firing
        // rem.triggered = true;
        // // removed - using MongoDB now
      }
    }

// Current conditions for debugging
const contextInfo = `\n\n📊 Current: ${currentHourMin} | ${currentCity} | Weather: ${currentWeather || 'N/A'} | Temp: ${currentTempF !== null ? currentTempF + '°F' : 'N/A'}`;

    if (dueReminders.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No smart reminders are due right now.${contextInfo}`
        }]
      };
    }

    const list = dueReminders.map(r => `🔔 ${r.message} (ID: ${r.id})`).join("\n");
    return {
      content: [{
        type: "text",
        text: `Due reminders:\n${list}${contextInfo}`
      }]
    };
  }
);

// ─── REST API ───────────────────────────────────────────────
const restApp = express();
restApp.use(express.json());

// CORS so your React app can call this
restApp.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE");
  next();
});

// Get all reminders
restApp.get("/api/reminders", async (req, res) => {
  try {
    const reminders = await loadReminders();
    res.json(reminders);
  } catch (err) {
    res.status(500).json({ error: "Failed to load reminders" });
  }
});

// Create a reminder
restApp.post("/api/reminder/create", async (req, res) => {
  try {
    const { message, triggerType, conditions } = req.body;
    const newReminder: SmartReminder = {
      id: Date.now(),
      message,
      triggerType,
      conditions: {
        ...conditions,
        time: conditions.time ? convertTo24Hour(conditions.time) : undefined,
      },
      createdAt: new Date().toISOString(),
      triggered: false,
    };
    await saveReminder(newReminder);
    res.json({ success: true, reminder: newReminder });
  } catch (err) {
    res.status(500).json({ error: "Failed to create reminder" });
  }
});

// Check which reminders are due
restApp.post("/api/reminder/check", async (req, res) => {
  try {
    const reminders = await loadReminders();
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const due: SmartReminder[] = [];
    for (const reminder of reminders) {
      if (reminder.triggered) continue;
      if (reminder.conditions.time && reminder.conditions.time === currentTime) {
        due.push(reminder);
      }
    }
    res.json({ due });
  } catch (err) {
    res.status(500).json({ error: "Failed to check reminders" });
  }
});

// Delete a reminder
restApp.delete("/api/reminder/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await deleteReminderById(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete reminder" });
  }
});

// Weather
restApp.post("/api/weather", async (req, res) => {
  try {
    const { city } = req.body;
    const apiKey = process.env.OPENWEATHER_API_KEY;
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=imperial`;
    const response = await fetch(url);
    const data = await response.json() as any;
    res.json({
      condition: data.weather?.[0]?.description || 'unknown',
      temperature: Math.round(data.main?.temp || 0),
      feels_like: Math.round(data.main?.feels_like || 0),
      humidity: data.main?.humidity || 0,
      city: data.name,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get weather" });
  }
});

// Get current location
restApp.get("/api/location", async (req, res) => {
  try {
    const response = await fetch("https://ipinfo.io/json");
    const data = await response.json() as { city?: string; region?: string; country?: string; loc?: string };
    res.json({
      city: data.city,
      region: data.region,
      country: data.country,
      coordinates: data.loc,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get location" });
  }
});

// Find nearby places
restApp.post("/api/places", async (req, res) => {
  try {
    const { location, keyword, radius = 5000, min_rating = 0 } = req.body;
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(keyword + ' near ' + location)}&radius=${radius}&key=${process.env.GOOGLE_PLACES_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json() as { results?: any[] };
    const places = (data.results || [])
      .filter((p: any) => (p.rating || 0) >= min_rating)
      .slice(0, 5)
      .map((p: any) => ({
        name: p.name,
        address: p.formatted_address,
        rating: p.rating,
        total_ratings: p.user_ratings_total,
      }));
    res.json({ places });
  } catch (err) {
    res.status(500).json({ error: "Failed to find places" });
  }
});

// Calendar - get all events
restApp.get("/api/calendar", async (req, res) => {
  try {
    const events = await loadEvents();
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: "Failed to load events" });
  }
});

// Calendar - create event
restApp.post("/api/calendar", async (req, res) => {
  try {
    const { title, date, time, duration } = req.body;
    if (!title || !date || !time) {
      res.status(400).json({ error: "title, date, and time are required" });
      return;
    }
    const newEvent = {
      id: Date.now(),
      title,
      date,
      time,
      duration: duration || 60,
      createdAt: new Date().toISOString(),
    };
    await saveEvent(newEvent);
    res.json({ success: true, event: newEvent });
  } catch (err) {
    res.status(500).json({ error: "Failed to create event" });
  }
});

// Calendar - delete event
restApp.delete("/api/calendar/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await deleteEventById(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete event" });
  }
});

// AI Chat using Gemini
restApp.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    const systemPrompt = `You are a smart reminder assistant built into a PWA app. You help users manage reminders, check weather, find nearby places, and manage calendar events.

When a user asks you to do something, respond with a JSON object in this exact format:
{
  "reply": "your friendly response to the user",
  "action": "action_name or null",
  "data": {}
}

Available actions:
- "create_reminder" → data: { message, triggerType, conditions: { time?, location?, weather? } }
- "check_reminders" → data: {}
- "get_weather" → data: { city }
- "find_places" → data: { keyword, location }
- "get_calendar" → data: {}
- "create_event" → data: { title, date, time, duration }
- null → just a conversation reply, no action needed

Examples:
User: "remind me to grab my umbrella if it rains tomorrow morning"
Response: {"reply": "Got it! I'll remind you to grab your umbrella when it rains!", "action": "create_reminder", "data": {"message": "Grab your umbrella", "triggerType": "combination", "conditions": {"time": "08:00", "weather": "rain"}}}

User: "what is the weather in New York?"
Response: {"reply": "Let me check the weather in New York for you!", "action": "get_weather", "data": {"city": "New York"}}

User: "what should I bring today?"
Response: {"reply": "Let me check current conditions!", "action": "get_weather", "data": {"city": "White Plains"}}

Always respond with valid JSON only. No extra text outside the JSON.`;

    const geminiMessages = history.map((h: any) => ({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.content }]
    }));

    geminiMessages.push({
      role: "user",
      parts: [{ text: message }]
    });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: geminiMessages,
          generationConfig: { maxOutputTokens: 1000 }
        })
      }
    );

    const data = await response.json() as any;
    console.log("Gemini response:", JSON.stringify(data, null, 2));
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 
      '{"reply": "Sorry I could not understand that.", "action": null, "data": {}}';

    const cleaned = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { reply: text, action: null, data: {} };
    }

    res.json(parsed);
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ 
      reply: "Something went wrong. Please try again.", 
      action: null, 
      data: {} 
    });
  }
});

restApp.listen(3002, '0.0.0.0', () => console.log("REST API running on http://localhost:3002"))
  .on('error', (err) => console.error("REST API error:", err));
// ─────────────────────────────────────────────────────────────

// === START SERVER ===

async function main() {
  // Connect to MongoDB first
  await connectDB();

  // Choose transport based on command line arguments
  if (useSSE) {
    // Add SSE routes to restApp instead of separate app
restApp.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

restApp.post("/messages", async (req, res) => {
  // handle SSE messages
});

console.log('SSE server running on port 3002');
  } else {
    // Use stdio transport for local development/desktop apps
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.info('{"jsonrpc": "2.0", "method": "log", "params": { "message": "Server running with stdio transport" }}');
  }
}

main().catch(console.error);