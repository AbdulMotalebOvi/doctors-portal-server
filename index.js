const express = require('express');
const cors = require('cors');
const app = express()
require('dotenv').config()
var jwt = require('jsonwebtoken');
const nodemailer = require("nodemailer");
const mg = require('nodemailer-mailgun-transport');
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 5000

app.use(cors())
app.use(express.json())



app.get('/', (req, res) => {
    res.send('Doctor Portal Server')
})

// mongodb

const { MongoClient, ServerApiVersion, ObjectId, Transaction } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.5urggkk.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });


function sendEmail(booking) {
    const { email, TreatmentName, appointmentDate, slot } = booking
    const auth = {
        auth: {
            api_key: process.env.SEND_MAILGUN_API_KEY,
            domain: process.env.SEND_MAILGUN_KEY
        }
    }

    const transporter = nodemailer.createTransport(mg(auth));
    transporter.sendMail({
        from: "ovi425764@gmail.com", // verified sender email
        to: email, // recipient email
        subject: `Your appointment for ${TreatmentName} is confirmed`,// Subject line
        text: "Hello world!", // plain text body
        html: `
        <h3>Your appointment is confirmed !</h3>
        <div>
            <p>Your appointment for: ${TreatmentName}</p>
            <p>Please visit us on ${appointmentDate} at ${slot}</p>
            <p>Thanks from Doctor Portal</p>
        </div>
        `, // html body
    }, function (error, info) {
        if (error) {
            console.log(error);
        } else {
            console.log('Email sent: ' + info.response);
        }
    });

}



function verifyJwt(req, res, next) {
    const authHeader = req.headers.authorization
    if (!authHeader) {
        return res.status(401).send('unauthorized access')
    }
    const token = authHeader.split(' ')[1]
    jwt.verify(token, process.env.JWT_WEB_TOKEN, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'forbidden access' })
        }
        req.decoded = decoded;
        next();
    })

}
async function run() {
    try {
        const appointmentCollection = client.db('doctorPortal').collection('makeAppointment');
        const bookedCollection = client.db('doctorPortal').collection('bookingCollection')
        const userCollection = client.db('doctorPortal').collection('userCollection')
        const doctorsCollection = client.db('doctorPortal').collection('doctorCollection')
        const paymentCollection = client.db('doctorPortal').collection('payments')
        // verify admin
        // Note: Make sure you use verifyAdmin after verifyJwt
        const verifyAdmin = async (req, res, next) => {
            const decodedEmail = req.decoded.email
            const query = { email: decodedEmail }
            const user = await userCollection.findOne(query)
            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next()
        }

        // appointment collection api
        app.get('/appointmentsTime', async (req, res) => {
            const date = req.query.date
            const query = {}
            const result = await appointmentCollection.find(query).toArray()
            const bookingQuery = { appointmentDate: date }
            const alreadyBooked = await bookedCollection.find(bookingQuery).toArray();

            result.forEach(option => {
                const optionsBooked = alreadyBooked.filter(book => book.TreatmentName === option.name)

                const bookedSlots = optionsBooked.map(book => book.slot)
                const restSLots = option.slots.filter(slot => !bookedSlots.includes(slot))
                option.slots = restSLots;
            })
            res.send(result)
        })

        // mongodb aggregate
        app.get('/v2/appointmentOptions', async (req, res) => {
            const date = req.query.date
            const options = await appointmentCollection.aggregate([
                {

                    $lookup:
                    {
                        from: 'bookingCollection',
                        localField: 'name',
                        foreignField: 'TreatmentName',
                        pipeline: [


                            {
                                $match: {
                                    $expr:
                                    {
                                        $eq: ['$appointmentDate', date]
                                    }
                                }
                            }

                        ],
                        as: 'booked'
                    }

                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: 1,
                        booked: {
                            $map: {
                                input: "$booked",
                                as: "book",
                                in: '$$book.slot'
                            }
                        }
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: {
                            $setDifference: ['$slots', '$booked']
                        }
                    }
                }
            ]).toArray()
            res.send(options)
        })


        app.get('/appointmentSpecialty', async (req, res) => {
            const query = {}
            const result = await appointmentCollection.find(query).project({ name: 1 }).toArray()
            res.send(result)
        })
        // DoctorCOllection APi
        app.get('/finDdoctors', verifyJwt, verifyAdmin, async (req, res) => {
            const query = {}
            const result = await doctorsCollection.find(query).toArray()
            res.send(result)
        })
        app.post('/doctors', verifyJwt, verifyAdmin, async (req, res) => {
            const query = req.body
            const result = await doctorsCollection.insertOne(query)
            res.send(result)
        })
        app.delete('/users/:id', async (req, res) => {
            const id = req.params.id
            const query = { _id: ObjectId(id) }
            const result = await userCollection.deleteOne(query)
            res.send(result)
        })
        app.delete('/dltdoctors/:id', verifyJwt, verifyAdmin, async (req, res) => {
            const id = req.params.id
            const query = { _id: ObjectId(id) }
            const result = await doctorsCollection.deleteOne(query)
            res.send(result)
        })


        // BookingCollection api

        app.get('/booking', verifyJwt, async (req, res) => {
            const email = req.query.email;
            const decodedEmail = req.decoded.email;

            if (email !== decodedEmail) {
                return res.status(403).send({ message: 'forbidden access' });
            }

            const query = { email: email }
            const bookings = await bookedCollection.find(query).toArray()
            res.send(bookings)
        })

        app.post('/booking', async (req, res) => {
            const booking = req.body
            console.log(booking)
            const query = {
                appointmentDate: booking.appointmentDate,
                email: booking.email,
                TreatmentName: booking.TreatmentName,
            }
            const alreadyBooked = await bookedCollection.find(query).toArray()
            if (alreadyBooked.length) {
                const message = `You Already Have a Booked on ${booking.appointmentDate}`
                return res.send({ acknowledged: false, message })
            }
            const result = await bookedCollection.insertOne(booking)
            sendEmail(booking)
            res.send(result)
        })
        app.get('/booking/:id', async (req, res) => {
            const id = req.params.id
            const query = { _id: ObjectId(id) }
            const result = await bookedCollection.findOne(query)
            res.send(result)
        })

        // payment
        app.post('/payments', async (req, res) => {
            const payment = req.body
            const result = await paymentCollection.insertOne(payment)
            const id = payment.bookingId
            const filter = { _id: ObjectId(id) }
            const updatedDoc = {
                $set: {
                    paid: true,
                    transaction: payment.transactionId
                }
            }
            const updatedResult = await bookedCollection.updateOne(filter, updatedDoc)
            res.send(result)
        })

        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body
            const price = booking.price
            const amount = price * 100

            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: "usd",
                "payment_method_types": [
                    "card"
                ],
            })
            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        })

        // json web token
        app.get('/jwt', async (req, res) => {
            const email = req.query.email
            const query = { email: email }
            const user = await userCollection.findOne(query)
            if (user) {
                const token = jwt.sign({ email }, process.env.JWT_WEB_TOKEN, { expiresIn: '1hr' })
                return res.send({ accessToken: token })
            }
            res.status(403).send({ accessToken: '' })
        })

        // create user

        app.get('/user', async (req, res) => {
            const query = {}
            const users = await userCollection.find(query).toArray()
            res.send(users)
        })
        app.get('/user/admin/:email', async (req, res) => {
            const email = req.params.email
            const query = { email }
            const user = await userCollection.findOne(query)
            res.send({ isAdmin: user?.role === 'admin' })
        })
        app.post('/user', async (req, res) => {
            const user = req.body
            const result = await userCollection.insertOne(user);
            res.send(result)
        })
        app.put('/user/admin/:id', verifyJwt, verifyAdmin, async (req, res) => {

            const id = req.params.id
            const filter = { _id: ObjectId(id) }
            const options = { upsert: true };
            const updateDoc = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await userCollection.updateOne(filter, updateDoc, options)
            res.send(result)
        })
        // temporay addprice
        // app.get('/addPrice', async (req, res) => {
        //     const filter = {}
        //     const option = { upsert: true }
        //     const updateDoc = {
        //         $set: {
        //             price: 99
        //         }
        //     }
        //     const result = await appointmentCollection.updateMany(filter, updateDoc, option)
        //     res.send(result)
        // })


    }
    finally {

    }
}
run().catch(console.dir)





app.listen(port, () => {
    console.log(`server runnig on port ${port}`)
})