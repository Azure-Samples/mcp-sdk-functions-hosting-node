import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ManagedIdentityCredential, OnBehalfOfCredential } from '@azure/identity';

const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-app/1.0";

// Function to create a new server instance for each request (stateless)
export const createServer = () => {
  const server = new McpServer({
    name: "weather",
    version: "1.0.0",
  });

  server.registerTool(
    "get-alerts",
    {
      title: "Get Weather Alerts",
      description: "Get weather alerts for a state",
      inputSchema: {
        state: z.string().length(2).describe("Two-letter state code (e.g. CA, NY)"),
      },
      outputSchema: z.object({
        alerts: z.string(),
      }),
    },
    async ({ state }) => {
      const stateCode = state.toUpperCase();
      const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
      const alertsData = await makeNWSRequest<AlertsResponse>(alertsUrl);

      if (!alertsData) {
        const output = { alerts: "Failed to retrieve alerts data" };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }

      const features = alertsData.features || [];
      if (features.length === 0) {
        const output = { alerts: `No active alerts for ${stateCode}` };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }

      const formattedAlerts = features.map(formatAlert);
      const alertsText = `Active alerts for ${stateCode}:\n\n${formattedAlerts.join("\n")}`;
      const output = { alerts: alertsText };

      return {
        content: [{ type: "text", text: alertsText }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "get-forecast",
    {
      title: "Get Weather Forecast",
      description: "Get weather forecast for a location",
      inputSchema: {
        latitude: z.number().min(-90).max(90).describe("Latitude of the location"),
        longitude: z
          .number()
          .min(-180)
          .max(180)
          .describe("Longitude of the location"),
      },
      outputSchema: z.object({
        forecast: z.string(),
      }),
    },
    async ({ latitude, longitude }) => {
      // Get grid point data
      const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
      const pointsData = await makeNWSRequest<PointsResponse>(pointsUrl);

      if (!pointsData) {
        const output = { forecast: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).` };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }

      const forecastUrl = pointsData.properties?.forecast;
      if (!forecastUrl) {
        const output = { forecast: "Failed to get forecast URL from grid point data" };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }

      // Get forecast data
      const forecastData = await makeNWSRequest<ForecastResponse>(forecastUrl);
      if (!forecastData) {
        const output = { forecast: "Failed to retrieve forecast data" };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }

      const periods = forecastData.properties?.periods || [];
      if (periods.length === 0) {
        const output = { forecast: "No forecast periods available" };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      }

      // Format forecast periods
      const formattedForecast = periods.map((period: ForecastPeriod) =>
        [
          `${period.name || "Unknown"}:`,
          `Temperature: ${period.temperature || "Unknown"}°${period.temperatureUnit || "F"}`,
          `Wind: ${period.windSpeed || "Unknown"} ${period.windDirection || ""}`,
          `${period.shortForecast || "No forecast available"}`,
          "---",
        ].join("\n"),
      );

      const forecastText = `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join("\n")}`;
      const output = { forecast: forecastText };

      return {
        content: [{ type: "text", text: forecastText }],
        structuredContent: output,
      };
    },
  );

  // Add Get Current User tool using On-Behalf-Of flow with built-in authentication and authorization
  server.registerTool(
    'get_current_user',
    {
      title: 'Get Current User',
      description: 'Get current logged-in user information from Microsoft Graph using Azure App Service authentication headers and On-Behalf-Of flow',
      inputSchema: {},
      outputSchema: {
        authenticated: z.boolean(),
        user: z.object({}).optional(),
        message: z.string().optional(),
      },
    },
    async (_, extra) => {
        const headers = extra?.requestInfo?.headers;

        if (!headers) {
            const output = { authenticated: false, message: 'No authentication headers found' };
            return {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                structuredContent: output
            };
        }

        try {
            // get the auth token from Authorization header and remove the "Bearer " prefix
            const authToken = (headers['authorization'] as string).split(' ')[1];

            const tokenExchangeAudience = process.env.TokenExchangeAudience ?? "api://AzureADTokenExchange";
            const publicTokenExchangeScope = `${tokenExchangeAudience}/.default`;
            const federatedCredentialClientId = process.env.OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID;
            const clientId = process.env.WEBSITE_AUTH_CLIENT_ID;

            const managedIdentityCredential = new ManagedIdentityCredential(federatedCredentialClientId!);

            const oboCredential = new OnBehalfOfCredential({
                tenantId: process.env.WEBSITE_AUTH_AAD_ALLOWED_TENANTS!,
                clientId: clientId!,
                userAssertionToken: authToken!,
                getAssertion: async () => (await managedIdentityCredential.getToken(publicTokenExchangeScope)).token
            });

            // Call Microsoft Graph API to get user information
            const graphResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
                headers: {
                    'Authorization': `Bearer ${(await oboCredential.getToken('https://graph.microsoft.com/.default'))?.token}`
                }
            });
            const graphData = await graphResponse.json();
            
            // Mask sensitive information (for demo purposes)
            const maskedUserData = { ...graphData as any };
            if (maskedUserData.businessPhones) {
                maskedUserData.businessPhones = maskedUserData.businessPhones.map(() => '[MASKED]');
            }
            if (maskedUserData.id) {
                maskedUserData.id = '[MASKED]';
            }
            
            const output = { authenticated: true, user: maskedUserData, message: 'Successfully retrieved user information from Microsoft Graph' };
            return {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                structuredContent: output
            };

        } catch (error) {
            console.error('Error during token exchange and Graph API call:', error);
            const errorOutput = {
                authenticated: false,
                message: `Error during token exchange and Graph API call. You're logged in but might need to grant consent to the application. Open a browser to the following link to consent: https://${process.env.WEBSITE_HOSTNAME}/.auth/login/aad?post_login_redirect_uri=https://${process.env.WEBSITE_HOSTNAME}/authcomplete`,
            };
            return {
                content: [{ type: 'text', text: JSON.stringify(errorOutput, null, 2) }],
                structuredContent: errorOutput
            };
        }
    }
  );

  return server;
}

// Helper function for making NWS API requests
async function makeNWSRequest<T>(url: string): Promise<T | null> {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/geo+json",
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error("Error making NWS request:", error);
    return null;
  }
}

interface AlertFeature {
  properties: {
    event?: string;
    areaDesc?: string;
    severity?: string;
    status?: string;
    headline?: string;
  };
}

// Format alert data
function formatAlert(feature: AlertFeature): string {
  const props = feature.properties;
  return [
    `Event: ${props.event || "Unknown"}`,
    `Area: ${props.areaDesc || "Unknown"}`,
    `Severity: ${props.severity || "Unknown"}`,
    `Status: ${props.status || "Unknown"}`,
    `Headline: ${props.headline || "No headline"}`,
    "---",
  ].join("\n");
}

interface ForecastPeriod {
  name?: string;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
}

interface AlertsResponse {
  features: AlertFeature[];
}

interface PointsResponse {
  properties: {
    forecast?: string;
  };
}

interface ForecastResponse {
  properties: {
    periods: ForecastPeriod[];
  };
}