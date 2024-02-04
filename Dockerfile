FROM node:latest

WORKDIR /app

COPY package*.json yarn.lock ./

RUN yarn config delete proxy
RUN yarn config delete https-proxy

RUN yarn --network-timeout 1000000

COPY . .

CMD ["yarn", "run", "example"]
