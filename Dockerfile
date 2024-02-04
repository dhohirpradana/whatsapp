FROM node:latest

WORKDIR /app

COPY package*.json yarn.lock ./

RUN yarn install --force

COPY . .

CMD ["yarn", "run", "example"]
