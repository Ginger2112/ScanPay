// Shopify Admin API client — marks a Shopify order as paid when Scantopay
// confirms the UPI payment. Used only when config.shopify is set (Jazz94).
import { config } from '../config.js';

const endpoint = () =>
  `https://${config.shopify.store}/admin/api/${config.shopify.apiVersion}/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Shopify-Access-Token': config.shopify.token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// Mark a Shopify order (GID, e.g. gid://shopify/Order/123) as paid.
export async function markOrderPaid(orderGid) {
  const data = await gql(
    `mutation Pay($input: OrderMarkAsPaidInput!) {
       orderMarkAsPaid(input: $input) {
         order { id displayFinancialStatus }
         userErrors { field message }
       }
     }`,
    { input: { id: orderGid } },
  );
  const r = data.orderMarkAsPaid;
  if (r.userErrors && r.userErrors.length) {
    throw new Error(r.userErrors.map((e) => e.message).join('; '));
  }
  return r.order; // { id, displayFinancialStatus: "PAID" }
}

// Resolve a Shopify order GID from its name (e.g. "#1001"), if needed.
export async function findOrderGidByName(name) {
  const q = name.startsWith('#') ? `name:${name}` : `name:#${name}`;
  const data = await gql(
    `query Find($q: String!) { orders(first: 1, query: $q) { edges { node { id name } } } }`,
    { q },
  );
  return data.orders.edges[0]?.node?.id || null;
}
