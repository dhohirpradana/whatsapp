FROM node:latest

WORKDIR /app

COPY package*.json yarn.lock ./

RUN yarn install --force

COPY . .

EXPOSE 3000

CMD ["yarn", "run", "app"]
